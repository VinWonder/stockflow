# StockFlow

Track every item in your **home godown** and **shops**: deliveries from suppliers (with date, sizes, colours, quantities and amounts),
transfers between stores with arrival checks, sales at the main shop, removals and additions approved by the admin, stocktakes,
low-stock alerts, and stock commands by **SMS or WhatsApp**.

```
stockflow/
├── backend/   Django + PostgreSQL API
└── web/       Installable web app (React + TypeScript, PWA): phones and PCs install it from the browser
```

---

## Accounts: every client is a business

Nobody needs the Django admin any more. A new client opens the app and taps **Create account**:

1. **You**: business name, owner's name, email (for password resets), phone, password.
2. **Main shop**: the head office (name, address, optional map pin).
3. **Other stores**: any number of shops and godowns.

That creates a **business** with its main shop and stores, and signs the owner in as its admin. Each business only
ever sees its own stores, products, suppliers, customers and staff, so many clients can share one server.
Store codes and product codes only need to be unique inside one business.

From the app the owner then adds **products & prices** (sizes, colours, buying and selling price), **team** members
(managers and shop staff, and the stores each works in), more **stores** (with map positions), and business details.
Users sign in with their username **or** email. **Forgot password?** emails a 6-digit code (valid 15 minutes, 5 tries)
from the Gmail account in `EMAIL_HOST_USER`; see [Email](#email-forgot-password-codes-gmail) below.

Hardware has no barcodes, so products are always found by **name, size and colour** (the camera scanner was removed).

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

**Sales:** recorded at any store where selling is switched on (shops by default; the owner can switch it on for a godown,
right from the Sell screen). Stock for the cart is re-checked live every few seconds, sales deduct stock immediately and keep
the buying cost at the time of sale (for real profit), and can be voided by a manager the same day or by the admin any time.
Payment:
- **Cash**: type the cash received and the app shows the change.
- **M-Pesa**: either **send a prompt** to the customer's phone (STK push; the sale completes itself when they enter their PIN)
  or **enter the 10-character code** from their message. Each code / payment can be used on one sale only.
- **Credit**: needs the customer's name and phone; optional cash deposit and a pay-by date (default 14 days). If the customer
  has a credit limit, a sale that would push them over it is refused. **Customers & credit** lists who owes what and what is
  overdue, and records payments (cash, M-Pesa code or bank) against each sale.

**Dashboard:** choose *All stores* or one shop/godown and every figure follows: stock value (at cost and at selling price),
today's sales vs yesterday at the same time, profit and margin (owner only), average sale, units sold, money collected by
method, credit given and owed, best sellers, and live **running low / out of stock** counts that open a restock list
(refreshed every 10 seconds, with a one-tap transfer from the store that has the most).

**Transfers with driver and live tracking:** every transfer records **who carries the goods** (name, phone) and **how**
(tuk-tuk, motorbike, pick-up, lorry, handcart, on foot) with the **number plate** for motor vehicles; dispatch is refused
without them. On dispatch the driver gets an SMS link to a page (no login) that shares the phone's GPS while open. The transfer
page shows the goods moving on Google Maps with distance left and arrival time; the receiving store is alerted when the vehicle
is within 200 m. Set each store's map pin (Stores → ⚙ → *I'm at this store*) so distance and arrival work.

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

- **Create your account:** open the app and tap *Create account* (or use the demo logins above).
- **Back-office (operator only):** http://127.0.0.1:8000/admin/ lists every business. Clients never need it.
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
| Auth | `POST /api/auth/register/`, `POST /api/auth/token/` (username or email), `POST /api/auth/refresh/`, `GET/PATCH /api/auth/me/`, `POST /api/auth/password/forgot/` · `verify/` · `reset/` · `change/` |
| Business & team | `GET/PATCH /api/business/`, `/api/users/` (owner only) |
| App config | `GET /api/config/` (maps key, M-Pesa mode, vehicle types) |
| Dashboard | `GET /api/dashboard/?location=` (stock value, today's sales vs yesterday, profit & margin, money collected, credit, best sellers, low/out items, 14-day in/out), `GET /api/stock-alerts/?location=` (live low/out counts) |
| Stores | `/api/locations/` (each with items, units, value, low, out) |
| Catalogue | `/api/categories/`, `/api/products/` (create with `new_variants: [{size, colour, selling_price, cost_price}]`), `/api/variants/?supplier=` |
| Suppliers | `/api/suppliers/` (total supplied, deliveries, products, what you owe), `/api/suppliers/<id>/products/` |
| Customers | `/api/customers/?owing=1`, `/api/customers/<id>/statement/` |
| Stock | `/api/stock/?location=&search=&state=low|out|alert&in_stock=1`, `/api/movements/?location=&variant=` |
| Deliveries | `/api/receipts/` · `post/` · `void/` · `payment/` |
| Transfers | `/api/transfers/?status_in=` · `approve/` · `reject/` · `cancel/` · `dispatch/` (driver & vehicle) · `driver/` · `track/` · `receive/`; driver page `GET/POST /api/track/<token>/` (no login) |
| Requests | `/api/requests/` · `confirm/` · `approve/` · `reject/` · `cancel/` |
| Sales | `/api/sales/` (`deposit`, `due_date`, `mpesa_payment`) · `void/` · `pay/`; M-Pesa prompts `POST /api/mpesa/stk/`, `GET /api/mpesa/stk/<id>/`, callback `POST /api/mpesa/callback/?token=` |
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

## Email (forgot-password codes): Gmail

1. Sign in to **vinwonder05@gmail.com** → Google Account → **Security** → turn on **2-Step Verification**.
2. Security → **App passwords** → create one named "StockFlow" → copy the 16-character password.
3. In `.env` (or Render → Environment) set `EMAIL_HOST_PASSWORD` to it. `EMAIL_HOST_USER` and `DEFAULT_FROM_EMAIL`
   already point at vinwonder05@gmail.com.

Until the password is set, the email (with the code) is printed in the server terminal, which is handy for testing.

## M-Pesa prompts (Daraja)

Out of the box `MPESA_BACKEND=console`: prompts are marked paid at once with a fake receipt (SIM…), so you can try the flow.
Typing M-Pesa codes works in every mode. For real prompts:

1. Create an app on https://developer.safaricom.co.ke (sandbox first: shortcode 174379 and the sandbox passkey).
2. Set `MPESA_BACKEND=daraja`, `MPESA_ENV=sandbox` (later `production`), `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`,
   `MPESA_SHORTCODE`, `MPESA_PASSKEY`. For a till number use `MPESA_TRANSACTION_TYPE=CustomerBuyGoodsOnline` and `MPESA_PARTY_B=<till>`.
3. Safaricom must reach `https://<your-domain>/api/mpesa/callback/?token=<MPESA_CALLBACK_TOKEN>` (public HTTPS). If the callback
   can't arrive, the app also asks Safaricom for the result while the till is waiting.

## Google Maps (live tracking)

Create a **Maps JavaScript API** key in Google Cloud, restrict it to your domain, and set `GOOGLE_MAPS_API_KEY`.
Without a key the app shows OpenStreetMap and "Open in Google Maps" links instead, so tracking still works.
Set `PUBLIC_APP_URL` (e.g. `https://stockflow.onrender.com`) so the driver's SMS link points at the right address.

## Deploying free: Render (app) + Neon (database)

1. **Database (Neon):** sign up at https://neon.com → create a project (region: AWS Europe, Frankfurt) → copy the
   connection string (`postgresql://…?sslmode=require`).
2. **Code (GitHub):** create a *private* repository and push this folder to it.
3. **App (Render):** sign up at https://render.com with GitHub → **New → Blueprint** → pick the repository.
   Render reads `render.yaml` and asks for:
   - `DATABASE_URL`: the Neon connection string
   - `EMAIL_HOST_PASSWORD`: the Gmail App Password (forgot-password emails)
   - `GOOGLE_MAPS_API_KEY`: optional, for Google Maps tracking

   Clients then create their own accounts in the app. (Optional: set `ADMIN_USERNAME` / `ADMIN_PASSWORD` to get an operator login for `/admin/`.)
4. Wait for the build (~5 minutes), then open `https://<name>.onrender.com` on your phone and install it.

On every start the server updates the database tables and checks the admin account, so there's nothing to run by hand.
Pushing to GitHub redeploys automatically. Free limits: the app sleeps after 15 minutes without visits and takes about
a minute to wake; uploaded product images are not kept between deploys (stock data is, it's in Neon).

## Deploying on your own server (Docker)
```bash
docker compose up -d --build
docker compose exec api python manage.py migrate
```
The image builds the web app too, so `https://your-domain/` is the app and `https://your-domain/api/` the API.
Put Nginx + Certbot in front for HTTPS (same as the PGCS guide); HTTPS is required for installing the app and for the
GPS tracking page. Set `DEBUG=False`, a new `SECRET_KEY`, your domain in `ALLOWED_HOSTS`, and schedule a daily `pg_dump` backup.

---

## Step 2 — the web app

A React + TypeScript progressive web app (PWA) in `web/`. It works in any browser and can be **installed like an app**
on Android, iPhone, Windows and Mac: home-screen icon, full screen, no browser bar, and it opens even with no
connection (data still needs the server).

Screens: sign in, dashboard (stock value, today's sales and profit, "needs your attention", 14-day in/out chart, low
stock, fastest movers, latest activity), stores and store pages with search by name/size/colour and item history,
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
The app must be opened over **HTTPS** (or `localhost`) for browsers to offer installing it and to share GPS location (driver tracking, store map pins).
- **Android (Chrome):** open the site → *Install StockFlow* on the sign-in or More screen (or ⋮ → *Install app*).
- **iPhone / iPad (Safari):** Share → *Add to Home Screen*.
- **Windows / Mac (Chrome or Edge):** the install icon in the address bar.

Updates install themselves: after you deploy, the app picks up the new version the next time it opens.

To change the app icon, edit `web/public/icon.svg` and run `npm run icons`.
