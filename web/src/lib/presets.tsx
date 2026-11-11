/** Suggestions shown while typing. Users can always type something else. */

export const CATEGORY_PRESETS = [
  'Taps & valves', 'Tanks', 'Pipes & fittings', 'Plumbing', 'Cement & building', 'Sand, ballast & blocks', 'Paint',
  'Roofing', 'Iron sheets', 'Steel & rods', 'Timber', 'Nails & screws', 'Bolts & nuts', 'Electrical', 'Cables & wires',
  'Bulbs & lighting', 'Tools', 'Power tools', 'Locks & hinges', 'Doors & windows', 'Tiles', 'Sanitary ware', 'Glass',
  'Wheelbarrows', 'Adhesives & sealants', 'Safety gear', 'Garden & farm', 'Gas & cookers',
];

const inches = ['1/8"', '1/4"', '3/8"', '1/2"', '5/8"', '3/4"', '1"', '1 1/4"', '1 1/2"', '2"', '2 1/2"', '3"', '4"', '5"', '6"', '8"', '10"', '12"', '14"', '16"'];

export const SIZE_PRESETS = [
  ...inches,
  '15mm', '20mm', '25mm', '32mm', '40mm', '50mm', '63mm', '75mm', '90mm', '110mm', '160mm',
  '1mm', '1.5mm', '2.5mm', '4mm', '6mm', '10mm',
  'Y8', 'Y10', 'Y12', 'Y16', 'Y20',
  'Gauge 26', 'Gauge 28', 'Gauge 30', 'Gauge 32',
  '2m', '2.5m', '3m', '6m', '12m',
  '1L', '4L', '5L', '20L', '100L', '500L', '1000L', '2000L', '5000L', '10000L',
  '1kg', '2kg', '5kg', '25kg', '50kg',
  'Small', 'Medium', 'Large',
];

export const COLOUR_PRESETS = ['White', 'Black', 'Grey', 'Silver', 'Red', 'Blue', 'Green', 'Maroon', 'Brown', 'Cream', 'Yellow', 'Orange', 'Clear'];

/** <datalist> elements used by inputs with list="…": pick from the list or type freely. */
export function PresetLists() {
  return (
    <>
      <datalist id="preset-categories">{CATEGORY_PRESETS.map((c) => <option key={c} value={c} />)}</datalist>
      <datalist id="preset-sizes">{SIZE_PRESETS.map((s) => <option key={s} value={s} />)}</datalist>
      <datalist id="preset-colours">{COLOUR_PRESETS.map((c) => <option key={c} value={c} />)}</datalist>
    </>
  );
}
