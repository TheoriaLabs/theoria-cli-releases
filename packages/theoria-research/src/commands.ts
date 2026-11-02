import type { ActionResult } from '@theoria/shared/actions';
import { artifactKinds, artifactLine, getArtifact, insideProject, listArtifacts, registerArtifact, type ArtifactKind } from './artifacts.ts';
import { claimDetail, claimLine, createClaim, getClaim, listClaims, recheckClaims, relations, settableStatuses, testClaim, testUsage, updateClaim, verifyClaim, type Relation } from './claims.ts';

/**
 * The text grammar of /claim, /claims, /artifact and /artifacts, the same for you and for the agent (through the
 * `theoria` tool). Each returns a structured result.
 */

export interface Who { runId?: string; by: 'user' | 'model' }

export const claimUsage = [
  '/claim <id>',
  '/claim new [hypothesis|supported] <statement>',
  '/claim set <id> <hypothesis|supported|refuted> [why]',
  '/claim edit <id> <new statement>',
  '/claim link <id> <supports|refutes|verifies|derived-from> <artifact id or path>[:<theorem>]',
  '/claim verify <id>',
  `/claim test <id> <data artifact or path> <${testUsage}>`,
].join(' · ');

export function claimsCommand(cwd: string, args: string): ActionResult {
  recheckClaims(cwd);
  const filter = args.trim().toLowerCase();
  const claims = listClaims(cwd).filter(claim => !filter || claim.status === filter || (filter === 'stale' && claim.verification?.stale));
  if (!claims.length) return { ok: true, text: filter ? `No ${filter} claims.` : 'No claims yet. /claim new <statement> records one.', details: { claims: [] } };
  const counts = Object.fromEntries(['hypothesis', 'supported', 'verified', 'refuted'].map(status => [status, listClaims(cwd).filter(claim => claim.status === status).length]));
  return {
    ok: true,
    text: [`Claims: ${Object.entries(counts).map(([status, count]) => `${count} ${status}`).join(' · ')}`, ...claims.map(claimLine)].join('\n'),
    details: { claims: claims.map(claim => ({ id: claim.id, status: claim.status, statement: claim.statement, refs: claim.artifactRefs, stale: !!claim.verification?.stale })) },
  };
}

export async function claimCommand(cwd: string, args: string, who: Who): Promise<ActionResult> {
  const [verb = '', ...rest] = args.trim().split(/\s+/);
  const tail = rest.join(' ');
  const lower = verb.toLowerCase();
  if (!verb) return { ok: false, text: `Usage: ${claimUsage}` };
  if (/^c\d+$/i.test(verb) && !tail) {
    recheckClaims(cwd);
    const claim = getClaim(cwd, verb);
    return claim ? { ok: true, text: claimDetail(cwd, claim).join('\n'), details: claim } : { ok: false, text: `No claim ${verb}.` };
  }
  if (lower === 'new') {
    const [first = '', ...statement] = rest;
    const status = (settableStatuses as readonly string[]).includes(first.toLowerCase()) && first.toLowerCase() !== 'refuted' ? first.toLowerCase() as 'hypothesis' | 'supported' : undefined;
    const text = status ? statement.join(' ') : tail;
    const claim = createClaim(cwd, { statement: text, ...(status ? { status } : {}), runId: who.runId, by: who.by });
    return { ok: true, text: `Recorded ${claimLine(claim)}`, details: claim };
  }
  if (lower === 'test') {
    const [id = '', target = '', ...spec] = rest;
    if (!getClaim(cwd, id)) return { ok: false, text: `No claim ${id || '(missing id)'}.` };
    if (!target || !spec.length) return { ok: false, text: `Usage: /claim test <id> <data file or artifact> <${testUsage}>` };
    let artifactId = target.toUpperCase();
    if (!/^A\d+$/i.test(target)) {
      try { artifactId = registerArtifact(cwd, { path: target, kind: 'dataset', runId: who.runId }).artifact.id; } catch (error) { return { ok: false, text: error instanceof Error ? error.message : String(error) }; }
    }
    const result = await testClaim(cwd, id, artifactId, spec.join(' '), who.runId);
    return {
      ok: result.verified,
      text: result.verified ? `${result.claim.id} is verified (statistical): ${result.reason}.` : `${id.toUpperCase()} is not verified: ${result.reason}.`,
      details: result.claim,
    };
  }
  if (lower === 'set' || lower === 'edit' || lower === 'link' || lower === 'verify') {
    const [id = '', ...more] = rest;
    if (!getClaim(cwd, id)) return { ok: false, text: `No claim ${id || '(missing id)'}.` };
    if (lower === 'verify') {
      const result = await verifyClaim(cwd, id, who.runId);
      return { ok: result.verified, text: result.verified ? `${result.claim.id} is verified. ${result.reason}.` : `${id.toUpperCase()} is not verified: ${result.reason}.`, details: result.claim };
    }
    if (lower === 'edit') {
      const claim = updateClaim(cwd, id, { statement: more.join(' ') }, who);
      return { ok: true, text: `Updated ${claimLine(claim)}`, details: claim };
    }
    if (lower === 'set') {
      const [status = '', ...why] = more;
      if (status.toLowerCase() === 'verified') return { ok: false, text: 'Only Lean verifies a claim: link a Lean file with `/claim link <id> verifies <file>:<theorem>`, then `/claim verify <id>`.' };
      if (!(settableStatuses as readonly string[]).includes(status.toLowerCase())) return { ok: false, text: `Status must be one of ${settableStatuses.join(', ')}.` };
      const claim = updateClaim(cwd, id, { status: status.toLowerCase() as (typeof settableStatuses)[number], ...(why.length ? { note: why.join(' ') } : {}) }, who);
      return { ok: true, text: `Updated ${claimLine(claim)}${who.by === 'model' ? ' (recorded as the agent\'s judgement)' : ''}`, details: claim };
    }
    const [relation = '', target = ''] = more;
    if (!(relations as readonly string[]).includes(relation)) return { ok: false, text: `Relation must be one of ${relations.join(', ')}.` };
    if (!target) return { ok: false, text: 'Name the artifact (A3) or a file path, with :theorem for verifies.' };
    const colon = target.lastIndexOf(':');
    const ref = colon > 0 && !/^[A-Za-z]:\\/.test(target) ? target.slice(0, colon) : target;
    const theorem = colon > 0 ? target.slice(colon + 1) : undefined;
    if (relation === 'verifies' && !theorem) return { ok: false, text: 'verifies needs the theorem: <file.lean>:<theorem>.' };
    let artifactId = ref;
    if (!/^A\d+$/i.test(ref)) {
      try { artifactId = registerArtifact(cwd, { path: ref, runId: who.runId }).artifact.id; } catch (error) { return { ok: false, text: error instanceof Error ? error.message : String(error) }; }
    } else if (!getArtifact(cwd, ref.toUpperCase())) return { ok: false, text: `No artifact ${ref}.` };
    let claim = updateClaim(cwd, id, { addRef: { artifactId: artifactId.toUpperCase(), relation: relation as Relation, ...(theorem ? { theorem } : {}) } }, who);
    let extra = '';
    if (relation === 'verifies') {
      const result = await verifyClaim(cwd, id, who.runId);
      claim = result.claim;
      extra = result.verified ? ` Lean: verified (${result.reason}).` : ` Not verified: ${result.reason}.`;
    }
    return { ok: true, text: `Linked ${claim.id} ${relation} ${artifactId.toUpperCase()}${theorem ? `:${theorem}` : ''}.${extra}`, details: claim };
  }
  return { ok: false, text: `Usage: ${claimUsage}` };
}

export const artifactUsage = '/artifact add <path> [kind] [description] · /artifact <id>';

export function artifactsCommand(cwd: string): ActionResult {
  const artifacts = listArtifacts(cwd);
  if (!artifacts.length) return { ok: true, text: 'No artifacts yet. /artifact add <path> registers a file.', details: { artifacts: [] } };
  return { ok: true, text: [`Artifacts: ${artifacts.length}`, ...artifacts.map(artifact => artifactLine(cwd, artifact))].join('\n'), details: { artifacts } };
}

export function artifactCommand(cwd: string, args: string, who: Who): ActionResult {
  const [verb = '', ...rest] = args.trim().split(/\s+/);
  if (/^A\d+$/i.test(verb)) {
    const artifact = getArtifact(cwd, verb.toUpperCase());
    return artifact ? { ok: true, text: artifactLine(cwd, artifact), details: artifact } : { ok: false, text: `No artifact ${verb}.` };
  }
  if (verb.toLowerCase() !== 'add' || !rest[0]) return { ok: false, text: `Usage: ${artifactUsage}` };
  const [path, maybeKind = '', ...description] = rest;
  const kind = (artifactKinds as readonly string[]).includes(maybeKind) ? maybeKind as ArtifactKind : undefined;
  const words = kind ? description : [maybeKind, ...description].filter(Boolean);
  try {
    insideProject(cwd, path!);
    const { artifact, created } = registerArtifact(cwd, { path: path!, ...(kind ? { kind } : {}), runId: who.runId, ...(words.length ? { description: words.join(' ') } : {}) });
    return { ok: true, text: `${created ? 'Registered' : 'Already registered, unchanged:'} ${artifactLine(cwd, artifact)}`, details: artifact };
  } catch (error) { return { ok: false, text: error instanceof Error ? error.message : String(error) }; }
}
