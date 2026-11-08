# StockFlow — Hardware Stock Control

Track every item in your **home godown** and **shops**: deliveries from suppliers (with date, sizes, colours, quantities and amounts),
transfers between stores with arrival checks, sales at the main shop, removals and additions approved by the admin, stocktakes,
low-stock alerts, and stock commands by **SMS or WhatsApp**.

```
stockflow/
├── backend/   Django + PostgreSQL API
└── web/       Installable web app (React + TypeScript, PWA): phones and PCs install it from the browser
```

---

## How it works (read this first)

### 1. The ledger: stock is never "edited"

Every change writes a permanent **movement** (like a bank statement line), and the quantity on hand is the running balance.
Nobody, not even the admin, can type over a stock figure. That gives you:

- the full history of every item at every store ("stock card"): who, what, when, why, which document
- no silent mistakes or theft hidden by edits: corrections are new, visible lines
- reports that always agree with the shelves

| Event | Movement | Stock |
|---|---|---|
| Supplier delivery (GRN) | `receipt` | + at the receiving store |
| Transfer dispatched | `transfer_out` | − at the source |
| Transfer received | `transfer_in` | + at the destination (only what actually arrived) |
| Sale | `sale` | − at the shop |
| Approved removal / addition | `removal` / `addition` | − / + |
| Stocktake posted | `count` | ± the difference |
| Voided sale / delivery | `sale_void` / `receipt_void` | reverses the original |

Rows are locked during each change, so two phones selling the last bag of cement at the same second can't push stock below zero,
and the database itself refuses negative stock as a final safety net.

### 2. Who can do what

| | Admin (owner) | Stock manager | Shop staff |
|---|---|---|---|
| See stores | All | Assigned stores | Assigned stores |
| Products, prices, stores, users | ✅ | view | view |
| Receive supplier deliveries | ✅ | ✅ own stores | — |
| Request transfers | ✅ (auto-approved) | ✅ | ✅ |
| Approve / reject transfers | ✅ | — | — |
| Dispatch transfer | ✅ | ✅ source store | — |
| Receive transfer | ✅ | ✅ | ✅ destination store |
| Ask for removal / addition | ✅ | ✅ | ✅ |
| Confirm goods were moved | ✅ | ✅ own stores | — |
| **Approve stock change** | ✅ | — | — |
| Record sales | ✅ | ✅ | ✅ (shops only, never the godown) |
| Stocktake | approve & post | count & submit | — |

### 3. The flows

**Transfer (godown → shop)**
```
REQUESTED ──admin approves──▶ APPROVED ──source dispatches──▶ IN TRANSIT ──destination counts & receives──▶ RECEIVED
   (stock checked)                         (stock leaves source)                (stock arrives; shortages flagged to admin)
```
The destination is notified the moment goods leave. If 10 bags were sent and 9 arrived, only 9 are added and the admin gets a
"⚠ arrived short" alert, so losses in transit can't hide.

**Removal / addition with approval (your WhatsApp/SMS idea)**
```
PENDING ──manager removes goods & confirms──▶ CONFIRMED ──admin approves──▶ APPROVED (stock updated automatically)
```
- **Admin wants goods removed:** creates a request in the app or texts `REMOVE GDN: CEM 10 #customer`. The manager gets a notification,
  removes the goods, then taps *Confirm* (or replies `DONE SR00012`), adjusting quantities if fewer were removed.
  The admin approves and the stock updates.
- **Manager already removed something:** texts `REMOVED GDN: PNT 4L WHITE 2 #damaged`. It goes straight to *confirmed* and waits for the admin.
- Stock only changes at **approval**, so a typo in a message can never move stock on its own.

**Main shop sales:** sales are recorded per shop, deduct stock immediately, store the buying cost at the time of sale (for real profit),
and can be voided by a manager the same day or by the admin any time. Godowns can't sell: goods must be transferred to a shop first.

**Stocktake:** the manager starts a count (the system snapshots expected quantities), enters what's on the shelves, and submits.
The admin sees every difference and posts; each difference becomes a visible `count` movement.

### 4. SMS / WhatsApp commands

Only phones registered to an active user are accepted; unknown numbers get no reply.

| Message | Meaning |
|---|---|
| `REMOVE GDN: CEM 10, PNT 4L WHITE 2 #damaged` | Ask for goods to be removed |
| `REMOVED SHP1: NAIL 3IN 5` | Goods already removed: needs admin approval |
| `ADD GDN: CEM 20` / `ADDED …` | Same for adding stock |
| `TRANSFER GDN>MAIN: CEM 10` | Request a transfer |
| `STOCK GDN CEM` / `STOCK CEM` | Check balance at one or all of your stores |
| `CONFIRM SR00012` or `DONE SR00012` | Manager: done as asked |
| `APPROVE SR00012` / `REJECT SR00012 wrong store` | Admin decision |
| `HELP` | Command list |

Items can be a SKU (`PNT-4L-WHT`) or a product code plus size/colour words (`PNT 4L WHITE`). Quantity can be written `10`, `x10`, `10pcs`
or `10bags`. Swahili verbs work too: `TOA` (remove), `ONGEZA` (add), `HAMISHA` (transfer), `SAWA` (confirm).
If a product has several sizes/colours and the message doesn't say which, the reply lists the options.

Reasons after `#` are recognised: damaged, expired, lost/stolen, return (to supplier), site/internal, customer/pickup, found, correction.

---

## Step 1 — Run the backend in VS Code

### 1.1 Install
- **Python 3.12**, **PostgreSQL 16** (with pgAdmin), **Git**, **VS Code** (same as the PGCS project; skip what you already have).
- Open the `stockflow` folder in VS Code and accept the recommended extensions.

### 1.2 Create the database
In **SQL Shell (psql)** (or `sudo -u postgres psql` on Linux):
```sql
CREATE DATABASE stockflow;
CREATE USER stock_user WITH PASSWORD 'stock_password';
ALTER ROLE stock_user SET timezone TO 'Africa/Nairobi';
GRANT ALL PRIVILEGES ON DATABASE stockflow TO stock_user;
\c stockflow
GRANT ALL ON SCHEMA public TO stock_user;
\q
```

### 1.3 Set up Python
```bash
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1        # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
copy .env.example .env            # macOS/Linux: cp .env.example .env
```
Edit `.env`: set `SECRET_KEY` (run `python -c "import secrets;print(secrets.token_urlsafe(50))"`) and check `DATABASE_URL`.

### 1.4 Create tables, demo data and run the tests
```bash
python manage.py makemigrations accounts inventory messaging
python manage.py migrate
python manage.py seed_demo
python manage.py test
```
`seed_demo` creates three stores (Home Godown `GDN`, Main Shop `MAIN`, Shop 2 `SHP2`), hardware products with sizes and colours
(cement, Crown paint, nails, iron sheets, PVC pipes, steel bars, cable), a supplier, opening stock and three users:

| Username | Password | Role | Phone (for SMS tests) |
|---|---|---|---|
| admin | admin12345 | Admin | 0700000001 |
| manager | manager12345 | Manager of GDN + MAIN | 0700000002 |
| shop2 | shop212345 | Staff at SHP2 | 0700000003 |

Change these passwords before real use.

The tests cover the whole logic: ledger balance, a transfer that arrives short, managers blocked from approving, negative stock blocked,
the full `REMOVE → DONE → APPROVE` SMS flow, already-done reports, ambiguous products, unknown phones ignored, store access limits,
sales (and godowns refusing sales), duplicate-request protection, deliveries updating average cost, stocktakes and the dashboard.

### 1.5 Run it
```bash
python manage.py runserver 0.0.0.0:8000
```
(or **F5 → "Backend: runserver"**). `0.0.0.0` lets your phone on the same Wi-Fi reach it at `http://<your-PC-IP>:8000`;
add that IP to `ALLOWED_HOSTS` in `.env`.

- **Admin panel:** http://127.0.0.1:8000/admin/ (stores, products, users and phone numbers; documents are read-only there so every change follows the rules)
- **API:** open `backend/api.http` and click *Send Request* on each block (REST Client extension) to log in, receive goods, transfer, and simulate SMS commands.

### 1.6 Try the SMS commands for free
With `SMS_BACKEND=console`, replies print in the terminal. Use `POST /api/messaging/simulate/` (block 8 in `api.http`) as admin or manager:
```
REMOVE GDN: PNT 4L WHITE 2 #damaged      → SR00001 created, manager notified
DONE SR00001          (log in as manager) → confirmed, admin notified
APPROVE SR00001       (log in as admin)   → stock reduced by 2
```

---

## API reference (what the web app calls)

| Area | Endpoints |
|---|---|
| Auth | `POST /api/auth/token/`, `POST /api/auth/refresh/`, `GET/PATCH /api/auth/me/` |
| Dashboard | `GET /api/dashboard/?location=` (stock value, today's sales & profit, actions waiting, 14-day in/out, top movers, low stock, recent activity) |
| Stores | `/api/locations/` (each with items, units, value, low, out) |
| Catalogue | `/api/categories/`, `/api/products/` (create with `variants: [{size, colour, selling_price}]`), `/api/variants/`, `/api/variants/barcode/<code>/` |
| Suppliers | `/api/suppliers/` (with total supplied and number of deliveries) |
| Stock | `/api/stock/?location=&search=&low=1&in_stock=1`, `/api/movements/?location=&variant=` |
| Deliveries | `/api/receipts/` · `post/` · `void/` · `payment/` |
| Transfers | `/api/transfers/` · `approve/` · `reject/` · `cancel/` · `dispatch/` · `receive/` |
| Requests | `/api/requests/` · `confirm/` · `approve/` · `reject/` · `cancel/` |
| Sales | `/api/sales/` · `void/` |
| Stocktake | `/api/counts/` · `record/` · `submit/` · `post/` |
| Notifications | `/api/notifications/` · `unread/` · `<id>/read/` · `read_all/` |
| Messaging | `/api/messaging/config/`, `/api/messaging/simulate/`, `/api/messaging/log/` |
| Webhooks | `POST /api/inbound/sms/?token=…` (Africa's Talking), `POST /api/inbound/whatsapp/?token=…` (Twilio) |

Rule errors come back as HTTP 409 with a clear sentence (e.g. *"Not enough Cement — 50kg at Home Godown: 3 available, 10 needed."*)
ready to show in the app. Every create accepts an optional `client_uuid`, so a retry on a weak network never records a delivery or sale twice.

---

## Connecting real SMS and WhatsApp (when you're ready)

**SMS: Africa's Talking.** Create an account, get an API key and buy a shortcode or virtual number. In `.env` set
`SMS_BACKEND=africastalking`, `AT_USERNAME`, `AT_API_KEY`. In the dashboard set the incoming-messages callback to
`https://your-domain/api/inbound/sms/?token=<INBOUND_TOKEN>`.

**WhatsApp: Twilio** (sandbox is free for testing). Set `WHATSAPP_BACKEND=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
`TWILIO_WHATSAPP_FROM`, and point "When a message comes in" to `https://your-domain/api/inbound/whatsapp/?token=<INBOUND_TOKEN>`.
For your own business number later, apply for the WhatsApp Business API through Twilio or Meta.

Webhooks need a public HTTPS address: use `ngrok http 8000` while developing. Give each user their phone number in the admin
(any format; it's stored as 2547XXXXXXXX) and tick *SMS alerts* / *WhatsApp alerts* if they want notifications on their phone too.

## Deploying free: Render (app) + Neon (database)

1. **Database (Neon):** sign up at https://neon.com → create a project (region: AWS Europe, Frankfurt) → copy the
   connection string (`postgresql://…?sslmode=require`).
2. **Code (GitHub):** create a *private* repository and push this folder to it.
3. **App (Render):** sign up at https://render.com with GitHub → **New → Blueprint** → pick the repository.
   Render reads `render.yaml` and asks for:
   - `DATABASE_URL`: the Neon connection string
   - `ADMIN_USERNAME` / `ADMIN_PASSWORD`: your first admin login (created on first start, then left alone)
4. Wait for the build (~5 minutes), then open `https://<name>.onrender.com` on your phone and install it.

On every start the server updates the database tables and checks the admin account, so there's nothing to run by hand.
Pushing to GitHub redeploys automatically. Free limits: the app sleeps after 15 minutes without visits and takes about
a minute to wake; uploaded product images are not kept between deploys (stock data is, it's in Neon).

## Deploying on your own server (Docker)
```bash
docker compose up -d --build
docker compose exec api python manage.py migrate
docker compose exec api python manage.py createsuperuser
```
The image builds the web app too, so `https://your-domain/` is the app and `https://your-domain/api/` the API.
Put Nginx + Certbot in front for HTTPS (same as the PGCS guide); HTTPS is required for installing the app and for the
barcode camera. Set `DEBUG=False`, a new `SECRET_KEY`, your domain in `ALLOWED_HOSTS`, and schedule a daily `pg_dump` backup.

---

## Step 2 — the web app

A React + TypeScript progressive web app (PWA) in `web/`. It works in any browser and can be **installed like an app**
on Android, iPhone, Windows and Mac: home-screen icon, full screen, no browser bar, and it opens even with no
connection (data still needs the server).

Screens: sign in, dashboard (stock value, today's sales and profit, "needs your attention", 14-day in/out chart, low
stock, fastest movers, latest activity), stores and store pages with search, barcode scanning and item history,
receive delivery, transfers with the status timeline (approve → dispatch → count on arrival), remove/add requests and
approvals, point of sale (cash / M-Pesa / credit), the SMS/WhatsApp message composer, suppliers, inbox with alerts,
and light/dark themes. Phone screens get a bottom bar; wide screens get a side rail.

### Develop
Install **Node.js 20+**, then:
```bash
cd web
npm install
npm run dev
```
Open http://localhost:5173 (or **F5 → "Backend + Web app"**). Vite forwards `/api` and `/admin` to Django on port 8000,
so run the backend too. Phones on the same Wi-Fi can open `http://<your-PC-IP>:5173`.

### Serve it from Django (one address for app and API)
```bash
cd web
npm run build          # creates web/dist
```
Django now serves the app at http://127.0.0.1:8000/ alongside `/api/` and `/admin/`. The Docker image does this for you.

### Install it as an app
The app must be opened over **HTTPS** (or `localhost`) for browsers to offer installing it and to allow the camera.
- **Android (Chrome):** open the site → *Install StockFlow* on the sign-in or More screen (or ⋮ → *Install app*).
- **iPhone / iPad (Safari):** Share → *Add to Home Screen*.
- **Windows / Mac (Chrome or Edge):** the install icon in the address bar.

Updates install themselves: after you deploy, the app picks up the new version the next time it opens.

To change the app icon, edit `web/public/icon.svg` and run `npm run icons`.
