/**
 * The statistics Theoria computes itself for statistical verification of claims: test statistics from raw samples,
 * exact tail probabilities, and their size in sigma. Nothing is taken from the agent but the data file and the
 * hypothesis; the p-value is never read from the data.
 *
 * Tails are computed directly (never as 1 − a near-1 number), so a 5σ result (p ≈ 2.9e-7) is accurate.
 */

/** ln Γ(x), Lanczos (g = 7, n = 9). */
export function logGamma(x: number): number {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let sum = c[0]!;
  for (let index = 1; index < 9; index += 1) sum += c[index]! / (z + index);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum);
}

/** Continued fraction for the incomplete beta (modified Lentz). */
function betaFraction(a: number, b: number, x: number): number {
  const tiny = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 10_000; m += 1) {
    const m2 = 2 * m;
    let step = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + step * d; if (Math.abs(d) < tiny) d = tiny;
    c = 1 + step / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d; h *= d * c;
    step = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + step * d; if (Math.abs(d) < tiny) d = tiny;
    c = 1 + step / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-15) break;
  }
  return h;
}

/** The regularized incomplete beta I_x(a, b). */
export function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (front * betaFraction(a, b, x)) / a : 1 - (front * betaFraction(b, a, 1 - x)) / b;
}

/** P(T ≥ t) for Student's t with `df` degrees of freedom: the upper tail, computed directly. */
export function studentUpperTail(t: number, df: number): number {
  const lower = 0.5 * incompleteBeta(df / (df + t * t), df / 2, 0.5);
  return t >= 0 ? lower : 1 - lower;
}

/** P(Z ≥ z) for the standard normal, from erfc (Cody-style rational approximation, accurate in the tails). */
export function normalUpperTail(z: number): number {
  return 0.5 * erfc(z / Math.SQRT2);
}

function erfc(x: number): number {
  // Numerical Recipes erfc via Chebyshev fit; relative error < 1.2e-7 everywhere, enough for sigma.
  const z = Math.abs(x);
  const t = 2 / (2 + z);
  const ty = 4 * t - 2;
  const coefficients = [-1.3026537197817094, 6.4196979235649026e-1, 1.9476473204185836e-2, -9.561514786808631e-3, -9.46595344482036e-4,
    3.66839497852761e-4, 4.2523324806907e-5, -2.0278578112534e-5, -1.624290004647e-6, 1.303655835580e-6, 1.5626441722e-8, -8.5238095915e-8,
    6.529054439e-9, 5.059343495e-9, -9.91364156e-10, -2.27365122e-10, 9.6467911e-11, 2.394038e-12, -6.886027e-12, 8.94487e-13, 3.13092e-13,
    -1.12708e-13, 3.81e-16, 7.106e-15, -1.523e-15, -9.4e-17, 1.21e-16, -2.8e-17];
  let d = 0;
  let dd = 0;
  for (let index = coefficients.length - 1; index > 0; index -= 1) {
    const previous = d;
    d = ty * d - dd + coefficients[index]!;
    dd = previous;
  }
  const value = t * Math.exp(-z * z + 0.5 * (coefficients[0]! + ty * d) - dd);
  return x >= 0 ? value : 2 - value;
}

/** The z for which P(Z ≥ z) = p: the result's size in sigma (one-sided). */
export function sigmaOf(p: number): number {
  if (!(p > 0)) return Infinity;
  if (p >= 1) return -Infinity;
  // Start from Acklam's approximation, then refine with Newton steps on the upper tail.
  let z = acklam(1 - p > 0.5 ? p : 1 - p);
  if (1 - p <= 0.5) z = -z;
  for (let step = 0; step < 6; step += 1) {
    const density = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
    const delta = (normalUpperTail(z) - p) / density;
    z += delta;
    if (Math.abs(delta) < 1e-12) break;
  }
  return z;
}

/** −Φ⁻¹(p) for small p (p ≤ 0.5). */
function acklam(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  if (p < 0.02425) {
    const q = Math.sqrt(-2 * Math.log(p));
    return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return -((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

/** P(X ≥ k) for X ~ Binomial(n, p), exactly. */
export function binomialUpperTail(k: number, n: number, p: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  return incompleteBeta(p, k, n - k + 1);
}

const mean = (xs: number[]) => xs.reduce((sum, x) => sum + x, 0) / xs.length;
const variance = (xs: number[]) => { const m = mean(xs); return xs.reduce((sum, x) => sum + (x - m) ** 2, 0) / (xs.length - 1); };

export interface TestResult { test: string; statistic: number; df?: number; pValue: number; sigma: number; n: number[]; effect: number; detail: string }

/** One-sample t: is the mean above (or below) mu0? */
export function oneSampleT(xs: number[], mu0: number, direction: 'greater' | 'less'): TestResult {
  const n = xs.length;
  const t = (mean(xs) - mu0) / Math.sqrt(variance(xs) / n);
  const signed = direction === 'greater' ? t : -t;
  const pValue = studentUpperTail(signed, n - 1);
  return { test: 'one-sample t', statistic: t, df: n - 1, pValue, sigma: sigmaOf(pValue), n: [n], effect: mean(xs) - mu0, detail: `mean ${fmt(mean(xs))} vs ${mu0}, n = ${n}` };
}

/** Welch's t: is the mean of a above (or below) the mean of b, without assuming equal variances? */
export function welchT(a: number[], b: number[], direction: 'greater' | 'less'): TestResult {
  const va = variance(a) / a.length;
  const vb = variance(b) / b.length;
  const t = (mean(a) - mean(b)) / Math.sqrt(va + vb);
  const df = (va + vb) ** 2 / (va ** 2 / (a.length - 1) + vb ** 2 / (b.length - 1));
  const pValue = studentUpperTail(direction === 'greater' ? t : -t, df);
  return { test: 'Welch t', statistic: t, df, pValue, sigma: sigmaOf(pValue), n: [a.length, b.length], effect: mean(a) - mean(b), detail: `means ${fmt(mean(a))} vs ${fmt(mean(b))}, n = ${a.length}, ${b.length}` };
}

/** Paired t on the differences a − b. */
export function pairedT(a: number[], b: number[], direction: 'greater' | 'less'): TestResult {
  if (a.length !== b.length) throw new Error(`A paired test needs as many values in each column (${a.length} and ${b.length}).`);
  const result = oneSampleT(a.map((x, index) => x - b[index]!), 0, direction);
  return { ...result, test: 'paired t', detail: `mean difference ${fmt(result.effect)}, n = ${a.length} pairs` };
}

/** Exact binomial: are successes more (or fewer) than p0 of the trials? Values are 0/1 (or false/true). */
export function binomialTest(xs: number[], p0: number, direction: 'greater' | 'less'): TestResult {
  const n = xs.length;
  const k = xs.filter(x => x === 1).length;
  if (xs.some(x => x !== 0 && x !== 1)) throw new Error('A binomial test needs 0/1 values.');
  const pValue = direction === 'greater' ? binomialUpperTail(k, n, p0) : binomialUpperTail(n - k, n, 1 - p0);
  return { test: 'exact binomial', statistic: k, pValue, sigma: sigmaOf(pValue), n: [n], effect: k / n - p0, detail: `${k}/${n} = ${fmt(k / n)} vs ${p0}` };
}

const fmt = (x: number) => (Math.abs(x) >= 1000 || (Math.abs(x) < 0.001 && x !== 0) ? x.toExponential(3) : x.toFixed(4));
