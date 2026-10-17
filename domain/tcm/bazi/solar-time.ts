// Meeus/NOAA equation of time. East longitude is positive; result in minutes.
// https://gml.noaa.gov/grad/solcalc/calcdetails.html
const rad = Math.PI / 180
const sin = (x: number) => Math.sin(x * rad)
const cos = (x: number) => Math.cos(x * rad)
export function equationOfTime(utc: number): number {
  const t = (utc / 86400000 + 2440587.5 - 2451545) / 36525
  const l = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360
  const m = 357.52911 + t * (35999.05029 - 0.0001537 * t)
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t)
  const ob = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60
    + 0.00256 * cos(125.04 - 1934.136 * t)
  const y = Math.tan(ob * rad / 2) ** 2
  return 4 / rad * (y * sin(2*l) - 2*e*sin(m) + 4*e*y*sin(m)*cos(2*l)
    - 0.5*y*y*sin(4*l) - 1.25*e*e*sin(2*m))
}
