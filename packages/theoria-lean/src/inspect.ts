/** Kernel declarations from the current file, not imported declarations. Types include section parameters. */
export interface LeanDeclaration {
  name: string;
  userName: string;
  kind: string;
  proof: boolean;
  source: boolean;
  importedParent: boolean;
  type: string;
  value: string;
  levels: string[];
  axioms: string[];
}

/** Compare full kernel expressions without source metadata or semantically irrelevant bound-variable names. */
export function inspectionScript(marker: string): string {
  return `
open Lean Elab Command in
#eval show CommandElabM Unit from do
  let rec clean (e : Expr) : Expr :=
    match e with
    | .app f a => .app (clean f) (clean a)
    | .lam _ t b i => .lam .anonymous (clean t) (clean b) i
    | .forallE _ t b i => .forallE .anonymous (clean t) (clean b) i
    | .letE _ t v b d => .letE .anonymous (clean t) (clean v) (clean b) d
    | .mdata _ b => clean b
    | .proj n i b => .proj n i (clean b)
    | e => e
  let env ← getEnv
  let rec importedParent (n : Name) : Bool :=
    match n with
    | .str p _ | .num p _ => env.isImportedConst p || importedParent p
    | .anonymous => false
  let mut count : Nat := 0
  for (n, ci) in env.constants.map₂.toList do
    if env.isImportedConst n then continue
    let axs ← collectAxioms n
    let proof ← liftTermElabM <| Meta.isProp ci.type
    let source := (← findDeclarationRanges? n).isSome
    let (kind, value) := match ci with
      | .thmInfo _ => ("theorem", "")
      | .defnInfo d => ("definition", reprStr (clean d.value))
      | .opaqueInfo d => ("opaque", reprStr (clean d.value))
      | .axiomInfo _ => ("axiom", "")
      | .inductInfo _ => ("inductive", "")
      | .ctorInfo _ => ("constructor", "")
      | .recInfo _ => ("recursor", "")
      | .quotInfo _ => ("quotient", "")
    let row := Json.mkObj [
      ("name", toJson n.toString), ("userName", toJson (privateToUserName n).toString),
      ("kind", toJson kind), ("proof", toJson proof),
      ("source", toJson source), ("importedParent", toJson (importedParent n)),
      ("type", toJson (reprStr (clean ci.type))), ("value", toJson value),
      ("levels", toJson (ci.levelParams.map Name.toString)),
      ("axioms", toJson (axs.toList.map Name.toString))]
    logInfo m!"${marker} {row.compress}"
    count := count + 1
  logInfo m!"${marker} END {count}"
`;
}

/** A missing end marker, truncated output or malformed row is never a partial successful inventory. */
export function readInspection(output: string, marker: string): LeanDeclaration[] | undefined {
  const rows: LeanDeclaration[] = [];
  let count: number | undefined;
  for (const line of output.split('\n')) {
    if (!line.startsWith(`${marker} `)) continue;
    const data = line.slice(marker.length + 1);
    if (/^END \d+$/.test(data)) { count = Number(data.slice(4)); continue; }
    try {
      const row = JSON.parse(data) as LeanDeclaration;
      if (!['name', 'userName', 'kind', 'type', 'value'].every(key => typeof row[key as keyof LeanDeclaration] === 'string')
        || ![row.proof, row.source, row.importedParent].every(value => typeof value === 'boolean')
        || ![row.levels, row.axioms].every(values => Array.isArray(values) && values.every(value => typeof value === 'string'))) return;
      rows.push(row);
    } catch { return; }
  }
  return count === rows.length && new Set(rows.map(row => row.name)).size === rows.length ? rows : undefined;
}
