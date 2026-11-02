/**
 * Frozen PutnamBench-30 membership, sampled from a635813f5edf297d928f9bd5ef8324a26bdde09c.
 * Exclude every putnam_2025_* task, group by the parent's theoria-splits-v1 60/20/20
 * hash split, rank each train/test group by SHA-256(`putnambench-30-v1:${id}`), and
 * take the first 15 from each. Keep these IDs and labels fixed across installations.
 * The parent declares the same labels so the subset cannot introduce split leakage.
 */
export const putnambench30Splits: Readonly<Record<string, 'train' | 'test'>> = Object.freeze({
  putnam_1966_b1: 'train',
  putnam_1969_a2: 'train',
  putnam_1970_a4: 'train',
  putnam_1975_b5: 'train',
  putnam_1980_a6: 'train',
  putnam_1984_a3: 'train',
  putnam_1985_a4: 'train',
  putnam_1987_a1: 'train',
  putnam_1989_a3: 'train',
  putnam_1991_b5: 'train',
  putnam_1993_b1: 'train',
  putnam_1994_b2: 'train',
  putnam_2000_b3: 'train',
  putnam_2001_b4: 'train',
  putnam_2003_b4: 'train',
  putnam_1967_b1: 'test',
  putnam_1967_b5: 'test',
  putnam_1967_b6: 'test',
  putnam_1969_a1: 'test',
  putnam_1970_b5: 'test',
  putnam_1975_b2: 'test',
  putnam_1977_b5: 'test',
  putnam_1981_a3: 'test',
  putnam_1982_a2: 'test',
  putnam_1982_b4: 'test',
  putnam_1984_b2: 'test',
  putnam_1985_a1: 'test',
  putnam_1991_b2: 'test',
  putnam_1995_b4: 'test',
  putnam_1999_b3: 'test',
});
