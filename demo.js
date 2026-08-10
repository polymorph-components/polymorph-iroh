// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/runtime/src/cabi/types.ts
function coreFuncTypeEquals(a, b) {
  return a.params.length === b.params.length && a.results.length === b.results.length && a.params.every((p, i) => p === b.params[i]) && a.results.every((r, i) => r === b.results[i]);
}
var ResourceTypeInfo = class {
  impl;
  dtor;
  constructor(impl, dtor = null) {
    this.impl = impl;
    this.dtor = dtor;
  }
};
function despecialize(t) {
  switch (t.kind) {
    case "tuple":
      return {
        kind: "record",
        fields: t.elements.map((e, i) => ({
          label: String(i),
          type: e
        }))
      };
    case "enum":
      return {
        kind: "variant",
        cases: t.labels.map((l) => ({
          label: l,
          type: null
        }))
      };
    case "option":
      return {
        kind: "variant",
        cases: [
          {
            label: "none",
            type: null
          },
          {
            label: "some",
            type: t.type
          }
        ]
      };
    case "result":
      return {
        kind: "variant",
        cases: [
          {
            label: "ok",
            type: t.ok
          },
          {
            label: "error",
            type: t.error
          }
        ]
      };
    case "map":
      return {
        kind: "list",
        element: despecialize({
          kind: "tuple",
          elements: [
            t.key,
            t.value
          ]
        })
      };
    default:
      return t;
  }
}
function discriminantType(cases) {
  const n = cases.length;
  if (!(0 < n && n < 2 ** 32)) throw new Error("assertion failed: case count");
  if (n <= 256) return {
    kind: "u8"
  };
  if (n <= 65536) return {
    kind: "u16"
  };
  return {
    kind: "u32"
  };
}
function contains(t, p) {
  if (t === null) return false;
  const d = despecialize(t);
  switch (d.kind) {
    case "list":
      return p(d) || contains(d.element, p);
    case "stream":
    case "future":
      return p(d) || contains(d.element, p);
    case "record":
      return p(d) || d.fields.some((f) => contains(f.type, p));
    case "variant":
      return p(d) || d.cases.some((c) => contains(c.type, p));
    default:
      return p(d);
  }
}
function valTypesEqual(a, b) {
  return a.length === b.length && a.every((t, i) => valTypeEqual(t, b[i]));
}
function valTypeEqual(a, b) {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "list": {
      const bb = b;
      return a.length === bb.length && valTypeEqual(a.element, bb.element);
    }
    case "record": {
      const bb = b;
      return a.fields.length === bb.fields.length && a.fields.every((f, i) => f.label === bb.fields[i].label && valTypeEqual(f.type, bb.fields[i].type));
    }
    case "tuple": {
      const bb = b;
      return a.elements.length === bb.elements.length && a.elements.every((e, i) => valTypeEqual(e, bb.elements[i]));
    }
    case "variant": {
      const bb = b;
      return a.cases.length === bb.cases.length && a.cases.every((c, i) => {
        const other = bb.cases[i];
        if (c.label !== other.label) return false;
        if (c.type === null || other.type === null) return c.type === other.type;
        return valTypeEqual(c.type, other.type);
      });
    }
    case "enum":
    case "flags": {
      const bb = b;
      return a.labels.length === bb.labels.length && a.labels.every((l, i) => l === bb.labels[i]);
    }
    case "option": {
      const bb = b;
      return valTypeEqual(a.type, bb.type);
    }
    case "result": {
      const bb = b;
      if (a.ok === null !== (bb.ok === null)) return false;
      if (a.error === null !== (bb.error === null)) return false;
      return (a.ok === null || valTypeEqual(a.ok, bb.ok)) && (a.error === null || valTypeEqual(a.error, bb.error));
    }
    case "map": {
      const bb = b;
      return valTypeEqual(a.key, bb.key) && valTypeEqual(a.value, bb.value);
    }
    case "own":
    case "borrow": {
      const bb = b;
      return a.rt === bb.rt;
    }
    case "stream":
    case "future": {
      const bb = b;
      if (a.element === null !== (bb.element === null)) return false;
      return a.element === null || valTypeEqual(a.element, bb.element);
    }
    case "error-context":
      return true;
    default:
      return true;
  }
}
function fmtValType(t) {
  if (t === null) return "_";
  switch (t.kind) {
    case "list":
      return t.length === void 0 ? `list<${fmtValType(t.element)}>` : `list<${fmtValType(t.element)}, ${t.length}>`;
    case "record":
      return `record{${t.fields.map((f) => `${f.label}: ${fmtValType(f.type)}`).join(", ")}}`;
    case "tuple":
      return `tuple<${t.elements.map(fmtValType).join(", ")}>`;
    case "variant":
      return `variant{${t.cases.map((c) => c.type === null ? c.label : `${c.label}(${fmtValType(c.type)})`).join(", ")}}`;
    case "enum":
      return `enum{${t.labels.join(", ")}}`;
    case "flags":
      return `flags{${t.labels.join(", ")}}`;
    case "option":
      return `option<${fmtValType(t.type)}>`;
    case "result":
      return `result<${fmtValType(t.ok)}, ${fmtValType(t.error)}>`;
    case "map":
      return `map<${fmtValType(t.key)}, ${fmtValType(t.value)}>`;
    case "own":
    case "borrow":
      return `${t.kind}<resource>`;
    case "stream":
    case "future":
      return `${t.kind}<${fmtValType(t.element)}>`;
    default:
      return t.kind;
  }
}

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/runtime/src/plan/loader.ts
var PlanError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "PlanError";
  }
};
var TranslateError = class extends Error {
  phase;
  detail;
  constructor(d) {
    super(`translator error [${d.phase}]: ${d.message}`);
    this.name = "TranslateError";
    this.phase = d.phase;
    this.detail = d.detail ?? d.message;
  }
  /** True iff the shim judged the *input component* invalid or malformed. */
  get isValidationVerdict() {
    return this.phase === "validation";
  }
};
var SUPPORTED_FORMAT_VERSION = 2;
function loadPlan(wire) {
  if (wire.formatVersion !== SUPPORTED_FORMAT_VERSION) {
    throw new PlanError(`unsupported plan formatVersion ${wire.formatVersion} (this runtime implements v${SUPPORTED_FORMAT_VERSION})`);
  }
  for (const required of [
    "modules",
    "initializers",
    "trampolines",
    "canonicalOptions",
    "types",
    "resourceTables",
    "imports",
    "exports"
  ]) {
    if (!Array.isArray(wire[required])) {
      throw new PlanError(`plan.${required} missing or not an array`);
    }
  }
  const importedResources = wire.importedResources ?? [];
  for (const [i, ir] of importedResources.entries()) {
    if (typeof ir?.import !== "number" || ir.import < 0 || ir.import >= wire.imports.length) {
      throw new PlanError(`importedResources[${i}].import = ${ir?.import} is not a valid index into plan.imports (length ${wire.imports.length})`);
    }
  }
  const tokenByResource = /* @__PURE__ */ new Map();
  const resourceTokens = wire.resourceTables.map((table) => {
    if (table.kind !== "concrete") return new ResourceTypeInfo(null, null);
    let token = tokenByResource.get(table.resource);
    if (token === void 0) {
      token = new ResourceTypeInfo(null, null);
      tokenByResource.set(table.resource, token);
    }
    return token;
  });
  const types = wire.types.map((t, i) => loadTypeDecl(t, resourceTokens, `types[${i}]`));
  const elems = (ts, what) => (ts ?? []).map((t, i) => t.element === null ? null : loadValType(t.element, resourceTokens, `${what}[${i}].element`));
  return {
    wire,
    types,
    resourceTokens,
    numImportedResources: importedResources.length,
    streamElems: elems(wire.streamTables, "streamTables"),
    futureElems: elems(wire.futureTables, "futureTables"),
    streamTableInstances: (wire.streamTables ?? []).map((t) => t.instance),
    futureTableInstances: (wire.futureTables ?? []).map((t) => t.instance)
  };
}
function resourceIndexOfDefined(plan, definedIndex) {
  return plan.numImportedResources + definedIndex;
}
function loadEnvelope(json) {
  let envelope;
  try {
    envelope = JSON.parse(json);
  } catch (e) {
    throw new PlanError(`envelope is not valid JSON: ${e}`);
  }
  if (envelope.error !== void 0) {
    throw new TranslateError(envelope.errorDetail ?? {
      phase: "internal",
      message: envelope.error
    });
  }
  if (!envelope.plan) throw new PlanError("envelope missing `plan`");
  loadPlan(envelope.plan);
  const adapters = /* @__PURE__ */ new Map();
  for (const a of envelope.adapters ?? []) {
    adapters.set(a.file, base64Decode(a.wasm));
  }
  return {
    wire: envelope.plan,
    adapters
  };
}
function base64Decode(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function loadTypeDecl(t, resourceTokens, where) {
  if (t.kind === "func") {
    const decl = t;
    return {
      kind: "func",
      funcType: {
        params: decl.params.map((p) => loadValType(p.type, resourceTokens, `${where}.params.${p.label}`)),
        results: decl.results.map((r, i) => loadValType(r, resourceTokens, `${where}.results[${i}]`)),
        async: decl.async
      },
      paramNames: decl.params.map((p) => p.label)
    };
  }
  return {
    kind: "value",
    type: loadValType(t, resourceTokens, where)
  };
}
function loadValType(t, resourceTokens, where) {
  switch (t.kind) {
    case "bool":
    case "s8":
    case "u8":
    case "s16":
    case "u16":
    case "s32":
    case "u32":
    case "s64":
    case "u64":
    case "f32":
    case "f64":
    case "char":
    case "string":
    case "error-context":
      return {
        kind: t.kind
      };
    case "list":
      return {
        kind: "list",
        element: loadValType(t.element, resourceTokens, `${where}.element`),
        ...t.length !== void 0 ? {
          length: t.length
        } : {}
      };
    case "record":
      return {
        kind: "record",
        fields: t.fields.map((f) => ({
          label: f.label,
          type: loadValType(f.type, resourceTokens, `${where}.${f.label}`)
        }))
      };
    case "tuple":
      return {
        kind: "tuple",
        elements: t.elements.map((e, i) => loadValType(e, resourceTokens, `${where}[${i}]`))
      };
    case "variant":
      return {
        kind: "variant",
        cases: t.cases.map((c) => ({
          label: c.label,
          type: c.type === null ? null : loadValType(c.type, resourceTokens, `${where}.${c.label}`)
        }))
      };
    case "enum":
      return {
        kind: "enum",
        labels: [
          ...t.labels
        ]
      };
    case "option":
      return {
        kind: "option",
        type: loadValType(t.type, resourceTokens, `${where}.some`)
      };
    case "result":
      return {
        kind: "result",
        ok: t.ok === null ? null : loadValType(t.ok, resourceTokens, `${where}.ok`),
        // Wire name is `err` (descriptor-ir.md); in-memory name is `error`
        // (cabi/types.ts).
        error: t.err === null ? null : loadValType(t.err, resourceTokens, `${where}.err`)
      };
    case "map":
      return {
        kind: "map",
        key: loadValType(t.key, resourceTokens, `${where}.key`),
        value: loadValType(t.value, resourceTokens, `${where}.value`)
      };
    case "flags":
      return {
        kind: "flags",
        labels: [
          ...t.labels
        ]
      };
    case "own":
    case "borrow": {
      const rt = resourceTokens[t.resource];
      if (rt === void 0) {
        throw new PlanError(`${where}: ${t.kind} references resource table ${t.resource}, but the plan has ${resourceTokens.length} resource tables`);
      }
      return {
        kind: t.kind,
        rt
      };
    }
    case "stream":
    case "future":
      return {
        kind: t.kind,
        element: t.element === null ? null : loadValType(t.element, resourceTokens, `${where}.element`)
      };
    default: {
      const exhaustive = t;
      throw new PlanError(`${where}: unknown ValType kind ${exhaustive.kind}`);
    }
  }
}

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/runtime/src/cabi/trap.ts
var Trap = class extends Error {
  constructor(message = "canonical ABI trap") {
    super(message);
    this.name = "Trap";
  }
};
function trap(message) {
  throw new Trap(message);
}
function trapIf(cond, message) {
  if (cond) trap(message);
}
var AssertionError = class extends Error {
  constructor(message = "internal assertion failed") {
    super(message);
    this.name = "AssertionError";
  }
};
function assert_(cond, message) {
  if (!cond) throw new AssertionError(message);
}

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/runtime/src/cabi/memory.ts
function ptrSize(ptrType) {
  return ptrType === "i32" ? 4 : 8;
}
function asIndex(v) {
  if (typeof v === "bigint") {
    assert_(v >= 0n && v <= BigInt(Number.MAX_SAFE_INTEGER), "index overflow");
    return Number(v);
  }
  assert_(Number.isSafeInteger(v) && v >= 0, "index not a safe integer");
  return v;
}
function loadIntU(mem, ptr, nbytes) {
  assert_(ptr + nbytes <= mem.length, "load out of bounds");
  switch (nbytes) {
    case 1:
      return mem.view.getUint8(ptr);
    case 2:
      return mem.view.getUint16(ptr, true);
    case 4:
      return mem.view.getUint32(ptr, true);
    case 8:
      return mem.view.getBigUint64(ptr, true);
  }
}
function loadIntS(mem, ptr, nbytes) {
  assert_(ptr + nbytes <= mem.length, "load out of bounds");
  switch (nbytes) {
    case 1:
      return mem.view.getInt8(ptr);
    case 2:
      return mem.view.getInt16(ptr, true);
    case 4:
      return mem.view.getInt32(ptr, true);
    case 8:
      return mem.view.getBigInt64(ptr, true);
  }
}
function loadPtr(mem, ptr) {
  return mem.ptrSize() === 4 ? loadIntU(mem, ptr, 4) : loadIntU(mem, ptr, 8);
}
function storeInt(mem, v, ptr, nbytes, signed = false) {
  assert_(ptr + nbytes <= mem.length, "store out of bounds");
  if (nbytes === 8) {
    assert_(typeof v === "bigint", "64-bit store requires bigint");
    if (signed) mem.view.setBigInt64(ptr, v, true);
    else mem.view.setBigUint64(ptr, v, true);
    return;
  }
  assert_(typeof v === "number" && Number.isInteger(v), "int store");
  switch (nbytes) {
    case 1:
      if (signed) mem.view.setInt8(ptr, v);
      else mem.view.setUint8(ptr, v);
      break;
    case 2:
      if (signed) mem.view.setInt16(ptr, v, true);
      else mem.view.setUint16(ptr, v, true);
      break;
    case 4:
      if (signed) mem.view.setInt32(ptr, v, true);
      else mem.view.setUint32(ptr, v, true);
      break;
  }
}
function storePtr(mem, v, ptr) {
  if (mem.ptrSize() === 4) storeInt(mem, v, ptr, 4);
  else storeInt(mem, BigInt(v), ptr, 8);
}
function bytesOf(mem, ptr, len) {
  assert_(ptr >= 0 && len >= 0 && ptr + len <= mem.length, "range OOB");
  return mem.bytes.subarray(ptr, ptr + len);
}
function writeBytes(mem, ptr, src) {
  assert_(ptr >= 0 && ptr + src.length <= mem.length, "write OOB");
  mem.bytes.set(src, ptr);
}
function trapIfRangeExceedsMemory(mem, ptr, byteLength, what = "out of bounds of linear memory") {
  trapIf(BigInt(ptr) + BigInt(byteLength) > BigInt(mem.length), what);
}

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/runtime/src/cabi/layout.ts
function alignTo(ptr, alignment2) {
  return Math.ceil(ptr / alignment2) * alignment2;
}
function alignment(t, ptrType) {
  const d = despecialize(t);
  switch (d.kind) {
    case "bool":
    case "s8":
    case "u8":
      return 1;
    case "s16":
    case "u16":
      return 2;
    case "s32":
    case "u32":
    case "f32":
    case "char":
      return 4;
    case "s64":
    case "u64":
    case "f64":
      return 8;
    case "string":
      return ptrSize(ptrType);
    case "error-context":
      return 4;
    case "list":
      return alignmentList(d.element, d.length ?? null, ptrType);
    case "record":
      return alignmentRecord(d.fields, ptrType);
    case "variant":
      return alignmentVariant(d.cases, ptrType);
    case "flags":
      return alignmentFlags(d.labels);
    case "own":
    case "borrow":
    case "stream":
    case "future":
      return 4;
  }
}
function alignmentList(elemType, maybeLength, ptrType) {
  if (maybeLength !== null) return alignment(elemType, ptrType);
  return ptrSize(ptrType);
}
function alignmentRecord(fields, ptrType) {
  let a = 1;
  for (const f of fields) a = Math.max(a, alignment(f.type, ptrType));
  return a;
}
function alignmentVariant(cases, ptrType) {
  return Math.max(alignment(discriminantType(cases), ptrType), maxCaseAlignment(cases, ptrType));
}
function maxCaseAlignment(cases, ptrType) {
  let a = 1;
  for (const c of cases) {
    if (c.type !== null) a = Math.max(a, alignment(c.type, ptrType));
  }
  return a;
}
function alignmentFlags(labels) {
  const n = labels.length;
  assert_(0 < n && n <= 32, "flags label count");
  if (n <= 8) return 1;
  if (n <= 16) return 2;
  return 4;
}
function elemSize(t, ptrType) {
  const d = despecialize(t);
  switch (d.kind) {
    case "bool":
    case "s8":
    case "u8":
      return 1;
    case "s16":
    case "u16":
      return 2;
    case "s32":
    case "u32":
    case "f32":
    case "char":
      return 4;
    case "s64":
    case "u64":
    case "f64":
      return 8;
    case "string":
      return 2 * ptrSize(ptrType);
    case "error-context":
      return 4;
    case "list":
      return elemSizeList(d.element, d.length ?? null, ptrType);
    case "record":
      return elemSizeRecord(d.fields, ptrType);
    case "variant":
      return elemSizeVariant(d.cases, ptrType);
    case "flags":
      return elemSizeFlags(d.labels);
    case "own":
    case "borrow":
    case "stream":
    case "future":
      return 4;
  }
}
function elemSizeList(elemType, maybeLength, ptrType) {
  if (maybeLength !== null) return maybeLength * elemSize(elemType, ptrType);
  return 2 * ptrSize(ptrType);
}
function elemSizeRecord(fields, ptrType) {
  let s = 0;
  for (const f of fields) {
    s = alignTo(s, alignment(f.type, ptrType));
    s += elemSize(f.type, ptrType);
  }
  assert_(s > 0, "empty record");
  return alignTo(s, alignmentRecord(fields, ptrType));
}
function elemSizeVariant(cases, ptrType) {
  let s = elemSize(discriminantType(cases), ptrType);
  s = alignTo(s, maxCaseAlignment(cases, ptrType));
  let cs = 0;
  for (const c of cases) {
    if (c.type !== null) cs = Math.max(cs, elemSize(c.type, ptrType));
  }
  s += cs;
  return alignTo(s, alignmentVariant(cases, ptrType));
}
function elemSizeFlags(labels) {
  const n = labels.length;
  assert_(0 < n && n <= 32, "flags label count");
  if (n <= 8) return 1;
  if (n <= 16) return 2;
  return 4;
}

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/runtime/src/cabi/float.ts
var CANONICAL_FLOAT32_NAN = 2143289344;
var CANONICAL_FLOAT64_NAN = 0x7ff8000000000000n;
var scratch = new DataView(new ArrayBuffer(8));
function coreF32ReinterpretI32(i) {
  scratch.setUint32(0, i, true);
  return scratch.getFloat32(0, true);
}
function coreF64ReinterpretI64(i) {
  scratch.setBigUint64(0, i, true);
  return scratch.getFloat64(0, true);
}
function coreI32ReinterpretF32(f) {
  scratch.setFloat32(0, f, true);
  return scratch.getUint32(0, true);
}
function coreI64ReinterpretF64(f) {
  scratch.setFloat64(0, f, true);
  return scratch.getBigUint64(0, true);
}
function canonicalizeNan32(f) {
  if (Number.isNaN(f)) return coreF32ReinterpretI32(CANONICAL_FLOAT32_NAN);
  return f;
}
function canonicalizeNan64(f) {
  if (Number.isNaN(f)) return coreF64ReinterpretI64(CANONICAL_FLOAT64_NAN);
  return f;
}
function decodeI32AsFloat(i) {
  return canonicalizeNan32(coreF32ReinterpretI32(i));
}
function decodeI64AsFloat(i) {
  return canonicalizeNan64(coreF64ReinterpretI64(i));
}
function maybeScrambleNan32(f) {
  if (Number.isNaN(f)) return coreF32ReinterpretI32(CANONICAL_FLOAT32_NAN);
  return f;
}
function maybeScrambleNan64(f) {
  if (Number.isNaN(f)) return coreF64ReinterpretI64(CANONICAL_FLOAT64_NAN);
  return f;
}
function encodeFloatAsI32(f) {
  if (Number.isNaN(f)) return CANONICAL_FLOAT32_NAN;
  return coreI32ReinterpretF32(f);
}
function encodeFloatAsI64(f) {
  if (Number.isNaN(f)) return CANONICAL_FLOAT64_NAN;
  return coreI64ReinterpretF64(f);
}

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/runtime/src/cabi/context.ts
function requireMemory(opts) {
  assert_(opts.memory !== null, "canonical option `memory` required");
  return opts.memory;
}
var LiftLowerContext = class {
  opts;
  inst;
  borrowScope;
  constructor(opts, inst = null, borrowScope = null) {
    this.opts = opts;
    this.inst = inst;
    this.borrowScope = borrowScope;
  }
  /**
   * definitions.py `LiftLowerContext.reallocate` routes the call through
   * canon_lift (reentrance bookkeeping and may_leave toggling around a
   * guest-side realloc export). v1 simplification: call the provided realloc
   * directly. The full path returns with the task machinery.
   */
  reallocate(old, oldByteLength, alignment2, newByteLength) {
    const realloc = this.opts.realloc;
    trapIf(realloc === null, "realloc required but not provided");
    return realloc(old, oldByteLength, alignment2, newByteLength);
  }
  allocate(alignment2, byteLength) {
    return this.reallocate(0, 0, alignment2, byteLength);
  }
};

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/runtime/src/cabi/handles.ts
var Table = class _Table {
  static MAX_LENGTH = 2 ** 28 - 1;
  array = [
    null
  ];
  free = [];
  get(i) {
    trapIf(i >= this.array.length, "table index out of range");
    trapIf(this.array[i] === null, "table entry empty");
    return this.array[i];
  }
  add(e) {
    let i;
    if (this.free.length > 0) {
      i = this.free.pop();
      assert_(this.array[i] === null);
      this.array[i] = e;
    } else {
      i = this.array.length;
      trapIf(i > _Table.MAX_LENGTH, "table full");
      this.array.push(e);
    }
    return i;
  }
  remove(i) {
    const e = this.get(i);
    this.array[i] = null;
    this.free.push(i);
    return e;
  }
  *[Symbol.iterator]() {
    for (const e of this.array) {
      if (e !== null) yield e;
    }
  }
};
var ResourceHandle = class {
  rt;
  rep;
  own;
  borrowScope;
  numLends;
  constructor(rt, rep, own, borrowScope = null) {
    this.rt = rt;
    this.rep = rep;
    this.own = own;
    this.borrowScope = borrowScope;
    this.numLends = 0;
  }
};
function requireInst(cx) {
  assert_(cx.inst !== null, "context requires a component instance");
  return cx.inst;
}
function liftOwn(cx, i, t) {
  const h = requireInst(cx).handles.remove(i);
  trapIf(!(h instanceof ResourceHandle), "not a resource handle");
  const rh = h;
  trapIf(rh.rt !== t.rt, "resource type mismatch");
  trapIf(rh.numLends !== 0, "handle still lent out");
  trapIf(!rh.own, "expected own handle");
  return rh.rep;
}
function liftBorrow(cx, i, t) {
  const scope = cx.borrowScope;
  assert_(scope !== null && typeof scope.addLender === "function", "lifting a borrow requires a subtask borrow scope");
  const h = requireInst(cx).handles.get(i);
  trapIf(!(h instanceof ResourceHandle), "not a resource handle");
  const rh = h;
  trapIf(rh.rt !== t.rt, "resource type mismatch");
  scope.addLender(rh);
  return rh.rep;
}
function lowerOwn(cx, rep, t) {
  const h = new ResourceHandle(t.rt, rep, true);
  return requireInst(cx).handles.add(h);
}
function lowerBorrow(cx, rep, t) {
  const scope = cx.borrowScope;
  assert_(scope !== null && typeof scope.numBorrows === "number", "lowering a borrow requires a task borrow scope");
  if (cx.inst !== null && cx.inst === t.rt.impl) {
    return rep;
  }
  const h = new ResourceHandle(t.rt, rep, false, scope);
  scope.numBorrows += 1;
  return requireInst(cx).handles.add(h);
}
function canonResourceNew(inst, rt, rep) {
  trapIf(!inst.mayLeave, "may_leave violation");
  const h = new ResourceHandle(rt, rep, true);
  return inst.handles.add(h);
}
function canonResourceDrop(inst, rt, i) {
  trapIf(!inst.mayLeave, "may_leave violation");
  const h = inst.handles.remove(i);
  trapIf(!(h instanceof ResourceHandle), "not a resource handle");
  const rh = h;
  trapIf(rh.rt !== rt, "resource type mismatch");
  trapIf(rh.numLends !== 0, "handle still lent out");
  if (rh.own) {
    assert_(rh.borrowScope === null);
    if (rt.dtor) rt.dtor(rh.rep);
  } else {
    assert_(rh.borrowScope !== null);
    rh.borrowScope.numBorrows -= 1;
  }
}
function canonResourceRep(inst, rt, i) {
  const h = inst.handles.get(i);
  trapIf(!(h instanceof ResourceHandle), "not a resource handle");
  const rh = h;
  trapIf(rh.rt !== rt, "resource type mismatch");
  return rh.rep;
}

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/runtime/src/cabi/strings.ts
var REALLOC_I32_MAX = 2 ** 32 - 1;
var REALLOC_MISALIGNED = "realloc return: result not aligned";
var REALLOC_OOB = "realloc return: beyond end of memory";
var MAX_STRING_BYTE_LENGTH = (1 << 28) - 1;
function utf16TagBig(ptrType) {
  return 1n << BigInt((ptrType === "i32" ? 4 : 8) * 8 - 1);
}
var utf8Decoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true
});
var utf16Decoder = new TextDecoder("utf-16le", {
  fatal: true,
  ignoreBOM: true
});
var utf8Encoder = new TextEncoder();
function latin1Decode(bytes) {
  const chunkSize = 8192;
  let s = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    s += String.fromCharCode(...chunk);
  }
  return s;
}
function toWellFormed(s) {
  return s.toWellFormed();
}
function encodeUtf16Le(s) {
  const wf = toWellFormed(s);
  const out = new Uint8Array(2 * wf.length);
  const view = new DataView(out.buffer);
  for (let i = 0; i < wf.length; i++) {
    view.setUint16(2 * i, wf.charCodeAt(i), true);
  }
  return out;
}
function loadString(cx, ptr) {
  const mem = requireMemory(cx.opts);
  const begin = loadPtr(mem, ptr);
  const taggedCodeUnits = loadPtr(mem, ptr + mem.ptrSize());
  return loadStringFromRange(cx, begin, taggedCodeUnits);
}
function loadStringFromRange(cx, ptr, taggedCodeUnits) {
  const mem = requireMemory(cx.opts);
  const tag = utf16TagBig(mem.ptrType());
  const units = BigInt(taggedCodeUnits);
  let alignment2;
  let byteLengthBig;
  let encoding;
  switch (cx.opts.stringEncoding) {
    case "utf8":
      alignment2 = 1;
      byteLengthBig = units;
      encoding = "utf-8";
      break;
    case "utf16":
      alignment2 = 2;
      byteLengthBig = 2n * units;
      encoding = "utf-16-le";
      break;
    case "latin1+utf16":
      alignment2 = 2;
      if ((units & tag) !== 0n) {
        byteLengthBig = 2n * (units ^ tag);
        encoding = "utf-16-le";
      } else {
        byteLengthBig = units;
        encoding = "latin-1";
      }
      break;
  }
  trapIf(byteLengthBig > BigInt(MAX_STRING_BYTE_LENGTH), "string too long");
  const byteLength = Number(byteLengthBig);
  const ptrBig = BigInt(ptr);
  trapIf(ptrBig % BigInt(alignment2) !== 0n, "misaligned string pointer");
  trapIfRangeExceedsMemory(mem, ptrBig, byteLengthBig, "string pointer/length out of bounds of memory");
  const p = Number(ptrBig);
  const bytes = bytesOf(mem, p, byteLength);
  try {
    switch (encoding) {
      case "utf-8":
        return utf8Decoder.decode(bytes);
      case "utf-16-le":
        return utf16Decoder.decode(bytes);
      case "latin-1":
        return latin1Decode(bytes);
    }
  } catch {
    trap(encoding === "utf-8" ? utf8ErrorMessage(bytes) : "invalid string encoding");
  }
}
function utf8ErrorMessage(bytes) {
  const INVALID = "invalid utf-8";
  const INCOMPLETE = "incomplete utf-8 byte sequence";
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b < 128) {
      i += 1;
      continue;
    }
    let width;
    let loMin = 128;
    let loMax = 191;
    if (b >= 194 && b <= 223) {
      width = 2;
    } else if (b === 224) {
      width = 3;
      loMin = 160;
    } else if (b >= 225 && b <= 236) {
      width = 3;
    } else if (b === 237) {
      width = 3;
      loMax = 159;
    } else if (b >= 238 && b <= 239) {
      width = 3;
    } else if (b === 240) {
      width = 4;
      loMin = 144;
    } else if (b >= 241 && b <= 243) {
      width = 4;
    } else if (b === 244) {
      width = 4;
      loMax = 143;
    } else {
      return INVALID;
    }
    for (let k = 1; k < width; k++) {
      if (i + k >= bytes.length) return INCOMPLETE;
      const c = bytes[i + k];
      const min = k === 1 ? loMin : 128;
      const max = k === 1 ? loMax : 191;
      if (c < min || c > max) return INVALID;
    }
    i += width;
  }
  return INVALID;
}
function storeString(cx, v, ptr) {
  const mem = requireMemory(cx.opts);
  const [begin, taggedCodeUnits] = storeStringIntoRange(cx, v);
  storeInt(mem, mem.ptrSize() === 4 ? Number(taggedCodeUnits) : taggedCodeUnits, ptr + mem.ptrSize(), mem.ptrSize());
  storeInt(mem, mem.ptrSize() === 4 ? begin : BigInt(begin), ptr, mem.ptrSize());
}
function storeStringIntoRange(cx, src) {
  const srcCodeUnits = src.length;
  switch (cx.opts.stringEncoding) {
    case "utf8":
      return storeUtf16ToUtf8(cx, src, srcCodeUnits);
    case "utf16":
      return storeStringCopyUtf16(cx, src, srcCodeUnits);
    case "latin1+utf16":
      return storeStringToLatin1OrUtf16(cx, src, srcCodeUnits);
  }
}
function storeStringCopyUtf16(cx, src, srcCodeUnits) {
  const mem = requireMemory(cx.opts);
  const dstByteLength = 2 * srcCodeUnits;
  assert_(dstByteLength <= REALLOC_I32_MAX);
  const ptr = cx.allocate(2, dstByteLength);
  trapIf(ptr !== alignTo(ptr, 2), REALLOC_MISALIGNED);
  trapIfRangeExceedsMemory(mem, ptr, dstByteLength, REALLOC_OOB);
  const encoded = encodeUtf16Le(src);
  assert_(dstByteLength === encoded.length);
  writeBytes(mem, ptr, encoded);
  return [
    ptr,
    BigInt(srcCodeUnits)
  ];
}
function storeUtf16ToUtf8(cx, src, srcCodeUnits) {
  const worstCaseSize = srcCodeUnits * 3;
  return storeStringToUtf8(cx, src, srcCodeUnits, worstCaseSize);
}
function storeStringToUtf8(cx, src, srcCodeUnits, worstCaseSize) {
  const mem = requireMemory(cx.opts);
  assert_(srcCodeUnits <= REALLOC_I32_MAX);
  let ptr = cx.allocate(1, srcCodeUnits);
  trapIfRangeExceedsMemory(mem, ptr, srcCodeUnits, REALLOC_OOB);
  for (let i = 0; i < src.length; i++) {
    const cu = src.charCodeAt(i);
    if (cu < 128) {
      mem.bytes[ptr + i] = cu;
    } else {
      assert_(worstCaseSize <= REALLOC_I32_MAX);
      ptr = cx.reallocate(ptr, srcCodeUnits, 1, worstCaseSize);
      trapIfRangeExceedsMemory(mem, ptr, worstCaseSize, REALLOC_OOB);
      const encoded = utf8Encoder.encode(src);
      writeBytes(mem, ptr + i, encoded.subarray(i));
      if (worstCaseSize > encoded.length) {
        ptr = cx.reallocate(ptr, worstCaseSize, 1, encoded.length);
        trapIfRangeExceedsMemory(mem, ptr, encoded.length, REALLOC_OOB);
      }
      return [
        ptr,
        BigInt(encoded.length)
      ];
    }
  }
  return [
    ptr,
    BigInt(srcCodeUnits)
  ];
}
function storeStringToLatin1OrUtf16(cx, src, srcCodeUnits) {
  const mem = requireMemory(cx.opts);
  const wf = toWellFormed(src);
  assert_(srcCodeUnits <= REALLOC_I32_MAX);
  let ptr = cx.allocate(2, srcCodeUnits);
  trapIf(ptr !== alignTo(ptr, 2), REALLOC_MISALIGNED);
  trapIfRangeExceedsMemory(mem, ptr, srcCodeUnits, REALLOC_OOB);
  let dstByteLength = 0;
  for (let i = 0; i < wf.length; i++) {
    const cu = wf.charCodeAt(i);
    if (cu < 1 << 8) {
      mem.bytes[ptr + dstByteLength] = cu;
      dstByteLength += 1;
    } else {
      const worstCaseSize = 2 * srcCodeUnits;
      assert_(worstCaseSize <= REALLOC_I32_MAX);
      ptr = cx.reallocate(ptr, srcCodeUnits, 2, worstCaseSize);
      trapIf(ptr !== alignTo(ptr, 2), REALLOC_MISALIGNED);
      trapIfRangeExceedsMemory(mem, ptr, worstCaseSize, REALLOC_OOB);
      for (let j = dstByteLength - 1; j >= 0; j--) {
        mem.bytes[ptr + 2 * j] = mem.bytes[ptr + j];
        mem.bytes[ptr + 2 * j + 1] = 0;
      }
      const encoded = encodeUtf16Le(wf);
      writeBytes(mem, ptr + 2 * dstByteLength, encoded.subarray(2 * dstByteLength));
      if (worstCaseSize > encoded.length) {
        ptr = cx.reallocate(ptr, worstCaseSize, 2, encoded.length);
        trapIf(ptr !== alignTo(ptr, 2), REALLOC_MISALIGNED);
        trapIfRangeExceedsMemory(mem, ptr, encoded.length, REALLOC_OOB);
      }
      const taggedCodeUnits = BigInt(encoded.length / 2) | utf16TagBig(mem.ptrType());
      return [
        ptr,
        taggedCodeUnits
      ];
    }
  }
  if (dstByteLength < srcCodeUnits) {
    ptr = cx.reallocate(ptr, srcCodeUnits, 2, dstByteLength);
    trapIf(ptr !== alignTo(ptr, 2), REALLOC_MISALIGNED);
    trapIfRangeExceedsMemory(mem, ptr, dstByteLength, REALLOC_OOB);
  }
  return [
    ptr,
    BigInt(dstByteLength)
  ];
}
function convertI32ToChar(i) {
  assert_(i >= 0);
  trapIf(i >= 1114112, "char out of range");
  trapIf(55296 <= i && i <= 57343, "char is a surrogate");
  return String.fromCodePoint(i);
}
function charToI32(c) {
  const i = c.codePointAt(0);
  assert_(i !== void 0, "empty char");
  assert_(c.length === (i > 65535 ? 2 : 1), "char must be one code point");
  assert_(0 <= i && i <= 55295 || 57344 <= i && i <= 1114111, "char must be a Unicode scalar value");
  return i;
}

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/runtime/src/cabi/store.ts
function store(cx, v, t, ptr) {
  const mem = requireMemory(cx.opts);
  assert_(ptr === alignTo(ptr, alignment(t, mem.ptrType())), "store misaligned");
  assert_(ptr + elemSize(t, mem.ptrType()) <= mem.length, "store OOB");
  const d = despecialize(t);
  switch (d.kind) {
    case "bool":
      storeInt(mem, Number(Boolean(v)), ptr, 1);
      return;
    case "u8":
      storeInt(mem, v, ptr, 1);
      return;
    case "u16":
      storeInt(mem, v, ptr, 2);
      return;
    case "u32":
      storeInt(mem, v, ptr, 4);
      return;
    case "u64":
      storeInt(mem, v, ptr, 8);
      return;
    case "s8":
      storeInt(mem, v, ptr, 1, true);
      return;
    case "s16":
      storeInt(mem, v, ptr, 2, true);
      return;
    case "s32":
      storeInt(mem, v, ptr, 4, true);
      return;
    case "s64":
      storeInt(mem, v, ptr, 8, true);
      return;
    case "f32":
      storeInt(mem, encodeFloatAsI32(v), ptr, 4);
      return;
    case "f64":
      storeInt(mem, encodeFloatAsI64(v), ptr, 8);
      return;
    case "char":
      storeInt(mem, charToI32(v), ptr, 4);
      return;
    case "string":
      storeString(cx, v, ptr);
      return;
    case "error-context":
      storeInt(mem, lowerErrorContext(cx, v), ptr, 4);
      return;
    case "list":
      storeList(cx, v, ptr, d.element, d.length ?? null);
      return;
    case "record":
      storeRecord(cx, v, ptr, d.fields);
      return;
    case "variant":
      storeVariant(cx, v, ptr, d.cases);
      return;
    case "flags":
      storeFlags(cx, v, ptr, d.labels);
      return;
    case "own":
      storeInt(mem, lowerOwn(cx, v, d), ptr, 4);
      return;
    case "borrow":
      storeInt(mem, lowerBorrow(cx, v, d), ptr, 4);
      return;
    case "stream":
      storeInt(mem, lowerStream(cx, v, d), ptr, 4);
      return;
    case "future":
      storeInt(mem, lowerFuture(cx, v, d), ptr, 4);
      return;
  }
}
function storeList(cx, v, ptr, elemType, maybeLength) {
  if (maybeLength !== null) {
    assert_(maybeLength === v.length, "fixed-length list length mismatch");
    storeListIntoValidRange(cx, v, ptr, elemType);
    return;
  }
  const mem = requireMemory(cx.opts);
  const [begin, length] = storeListIntoRange(cx, v, elemType);
  storePtr(mem, begin, ptr);
  storePtr(mem, length, ptr + mem.ptrSize());
}
function storeListIntoRange(cx, v, elemType) {
  const mem = requireMemory(cx.opts);
  const byteLength = v.length * elemSize(elemType, mem.ptrType());
  assert_(byteLength <= REALLOC_I32_MAX);
  const align = alignment(elemType, mem.ptrType());
  const ptr = cx.allocate(align, byteLength);
  trapIf(ptr !== alignTo(ptr, align), REALLOC_MISALIGNED);
  trapIf(ptr + byteLength > mem.length, REALLOC_OOB);
  storeListIntoValidRange(cx, v, ptr, elemType);
  return [
    ptr,
    v.length
  ];
}
function storeListIntoValidRange(cx, v, ptr, elemType) {
  const mem = requireMemory(cx.opts);
  const size = elemSize(elemType, mem.ptrType());
  for (let i = 0; i < v.length; i++) {
    store(cx, v[i], elemType, ptr + i * size);
  }
}
function storeRecord(cx, v, ptr, fields) {
  const mem = requireMemory(cx.opts);
  let p = ptr;
  for (const f of fields) {
    p = alignTo(p, alignment(f.type, mem.ptrType()));
    store(cx, v[f.label], f.type, p);
    p += elemSize(f.type, mem.ptrType());
  }
}
function matchCase(v, cases) {
  const keys = Object.keys(v);
  assert_(keys.length === 1, "variant value must have exactly one case");
  const label2 = keys[0];
  const matches = cases.flatMap((c, i) => c.label === label2 ? [
    i
  ] : []);
  assert_(matches.length === 1, `variant case '${label2}' not found`);
  return [
    matches[0],
    v[label2]
  ];
}
function storeVariant(cx, v, ptr, cases) {
  const mem = requireMemory(cx.opts);
  const [caseIndex, caseValue] = matchCase(v, cases);
  const discSize = elemSize(discriminantType(cases), mem.ptrType());
  storeInt(mem, caseIndex, ptr, discSize);
  let p = ptr + discSize;
  p = alignTo(p, maxCaseAlignment(cases, mem.ptrType()));
  const c = cases[caseIndex];
  if (c.type !== null) {
    store(cx, caseValue, c.type, p);
  }
}
function storeFlags(cx, v, ptr, labels) {
  const mem = requireMemory(cx.opts);
  const i = packFlagsIntoInt(v, labels);
  storeInt(mem, i, ptr, elemSizeFlags(labels));
}
function packFlagsIntoInt(v, labels) {
  let i = 0;
  let shift = 0;
  for (const l of labels) {
    i = (i | (v[l] ? 1 : 0) << shift) >>> 0;
    shift += 1;
  }
  return i;
}

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/runtime/src/task/scheduler.ts
var CANCELLED_FALSE = false;
var CANCELLED_TRUE = true;
var NeedsJspi = class extends Error {
  constructor(what) {
    super(`needs JSPI (M2 phase 3): ${what}`);
    this.name = "NeedsJspi";
  }
};
function needsJspi(what) {
  throw new NeedsJspi(what);
}
var PendingCapability = class extends Error {
  constructor(what) {
    super(`pending-capability: ${what}`);
    this.name = "PendingCapability";
  }
};
function readSeed() {
  let raw;
  try {
    raw = Deno.env.get("DELTIC_SCHED_SEED");
  } catch {
    return null;
  }
  if (raw === void 0 || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n) >>> 0;
}
var seed = readSeed();
var rngState = 0;
function nextRandom() {
  let x = rngState || 2654435769;
  x ^= x << 13;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  x >>>= 0;
  rngState = x;
  return x;
}
function chooseCandidate(candidates) {
  assert_(candidates.length > 0, "chooseCandidate on an empty candidate set");
  if (seed === null) return candidates[0];
  return candidates[nextRandom() % candidates.length];
}
var threadStack = [];
function pushCurrentThread(t) {
  threadStack.push(t);
}
function popCurrentThread(t) {
  const top = threadStack.pop();
  assert_(top === t, "current-thread stack imbalance");
}
function withActivation(t, fn) {
  threadStack.push(t);
  entryStack.push(t);
  try {
    return fn();
  } finally {
    entryStack.pop();
    const top = threadStack.pop();
    assert_(top === t, "withActivation: current-thread stack imbalance");
  }
}
var entryStack = [];
function activationOf() {
  return entryStack[entryStack.length - 1] ?? activationClaims[activationClaims.length - 1] ?? void 0;
}
var activationClaims = [];
function claimActivationAmbient(t) {
  if (t === null || t === void 0) return;
  if (AMBIENT_TRACE) traceAmbient("claim", t);
  const i = activationClaims.indexOf(t);
  if (i === activationClaims.length - 1 && i !== -1) return;
  if (i !== -1) activationClaims.splice(i, 1);
  activationClaims.push(t);
}
function traceAmbient(what, t) {
  console.error(`[amb] ${what} ${dbgId(t)} | stack=[${threadStack.map(dbgId).join(",")}] claims=[${activationClaims.map(dbgId).join(",")}] resuming=${resumingThread === null ? "-" : dbgId(resumingThread)}
${(new Error().stack ?? "").split("\n").slice(2, 6).join("\n")}`);
}
var dbgIds = /* @__PURE__ */ new WeakMap();
var nextDbgId = 1;
function dbgId(t) {
  if (t === null || t === void 0 || typeof t !== "object") return String(t);
  let id = dbgIds.get(t);
  if (id === void 0) {
    id = nextDbgId++;
    dbgIds.set(t, id);
  }
  return `T${id}`;
}
function releaseActivationAmbient(t) {
  if (t === null || t === void 0) return;
  if (AMBIENT_TRACE) traceAmbient("release", t);
  let i = activationClaims.indexOf(t);
  if (i === -1) {
    const implicit = t?.task?.implicitThread;
    if (implicit === void 0 || implicit === null) return;
    i = activationClaims.indexOf(implicit);
    if (i === -1) return;
  }
  activationClaims.splice(i, 1);
}
var resumingThread = null;
function setResumingThread(t) {
  if (AMBIENT_TRACE) traceAmbient("set-resuming", t);
  assert_(resumingThread === null || resumingThread === t, "two activations claim the resumed ambient at once \u2014 the resolve-one-per-turn discipline was violated");
  resumingThread = t;
}
function hasResumingThread() {
  return resumingThread !== null;
}
function clearResumingThread() {
  resumingThread = null;
}
function consumeClaimIfRunning() {
  if (resumingThread !== null && activationOf() === resumingThread) {
    resumingThread = null;
  }
}
function releaseClaimOf(t) {
  releaseActivationAmbient(t);
  if (resumingThread !== null && (resumingThread === t || t?.task?.implicitThread === resumingThread)) {
    resumingThread = null;
  }
}
var AMBIENT_TRACE = (() => {
  try {
    return Deno.env.get("CE_AMBIENT_TRACE") === "1";
  } catch {
    return false;
  }
})();
function ambientDebug() {
  return {
    stack: [
      ...threadStack
    ],
    claims: [
      ...activationClaims
    ],
    resuming: resumingThread
  };
}
function resolveAmbient() {
  return threadStack[threadStack.length - 1] ?? activationClaims[activationClaims.length - 1] ?? resumingThread ?? void 0;
}
function currentThread() {
  if (AMBIENT_TRACE && threadStack.length === 0) {
    console.error(`[ambient] bracket empty; claims=${activationClaims.length} head=${activationClaims[0]?.constructor?.name ?? "none"} resuming=${resumingThread?.constructor?.name ?? "none"}`);
  }
  const t = resolveAmbient();
  if (t === void 0) {
    throw new PendingCapability("instantiation-time task context \u2014 a task-scoped canonical built-in ran outside any task (a core start function calling task.return / task.cancel / thread.yield / subtask.*; see test/async/dont-block-start.wast)");
  }
  return t;
}
function maybeCurrentThread() {
  return resolveAmbient();
}
function currentTask() {
  return currentThread().task;
}
function maybeCurrentTask() {
  return maybeCurrentThread()?.task ?? null;
}
var Store = class {
  waiting = [];
  nestingDepth = 0;
  /**
   * Host-import promises this store is waiting on. Non-empty means progress
   * is possible but only after a microtask turn — see `drive` in
   * exec/boundary.ts. (definitions.py has no analogue: its host functions run
   * on real threads.)
   */
  pendingHostCalls = /* @__PURE__ */ new Set();
  /**
   * An exception raised by a host import's promise (a rejection, or a trap
   * thrown while lowering its results). It cannot propagate out of the
   * microtask that produced it, so it is parked here and rethrown by whoever
   * is driving the store — which is the call the guest is blocked in.
   */
  hostFailure = void 0;
  startWaiting(t) {
    assert_(!this.waiting.includes(t), "thread already in the waiting list");
    this.waiting.push(t);
  }
  stopWaiting(t) {
    const i = this.waiting.indexOf(t);
    assert_(i !== -1, "thread not in the waiting list");
    this.waiting.splice(i, 1);
  }
  /** Ready waiting threads, in wait order (the FIFO of the default policy). */
  readyCandidates() {
    return this.waiting.filter((t) => t.ready());
  }
  /**
   * Threads parked on a Promise (the jspi `awaitValue` seam). They are not in
   * `waiting` — nothing the scheduler can do makes them ready — so the driving
   * loop tracks them separately and resumes them when their promise settles.
   */
  // deno-lint-ignore no-explicit-any
  awaiting = /* @__PURE__ */ new Set();
  /**
   * Settled-but-unserviced activation tails, in settle order.
   *
   * A settled `awaitValue` is the rest of an activation that already finished
   * its wasm: result shaping, the callback loop, `exit_implicit_thread` (and
   * with it the exclusive-thread release). The reference runs all of that
   * atomically inside `Thread.resume`; under jspi it lands a few engine
   * microtasks after the observable effects of the activation (`task.return`
   * flips `resolved` DURING the wasm, the settle only afterwards — jspi
   * pin (j)). Any scheduling decision taken in that window sees phantom
   * state — a finished callee still "holding" its exclusive slot made
   * cancellable.wast report STARTING for an entry the reference admits. So
   * settlement is recorded EAGERLY (at park time, below), `tick` refuses to
   * run anything while a tail is unserviced, and the driving loop services
   * this queue first.
   */
  settled = [];
  /**
   * Park `t` on `promise` (jspi `awaitValue`), with EAGER settle tracking.
   *
   * The `.then` here is also what closes the claim discipline for
   * resumptions the driver did not settle itself (a guest built-in resolving
   * another activation's suspension — `subtask.cancel` delivering a
   * cancellation): the claim taken at settle time must survive until the
   * resumed activation parks again or finishes, and "finished" is exactly
   * this continuation firing. See `releaseClaimOf`.
   */
  // deno-lint-ignore no-explicit-any
  noteAwaiting(t, promise) {
    this.awaiting.add(t);
    promise.then((value) => {
      this.settled.push({
        t,
        value,
        failure: void 0
      });
      releaseClaimOf(t);
    }, (e) => {
      this.settled.push({
        t,
        value: void 0,
        failure: {
          error: e
        }
      });
      releaseClaimOf(t);
    });
  }
  /**
   * Service every settled activation tail, in settle order. Returns whether
   * anything ran. EVERY driving loop must call this before (and interleaved
   * with) `tick` — the queue gates `tick`, so a driver that never services
   * it wedges the store (observed: host-stream pumping between export
   * calls). A `resumeWith` may throw (trap unwinding); callers propagate or
   * park it exactly as they do for `tick`.
   */
  serviceSettled() {
    let did = false;
    while (this.settled.length > 0) {
      const s = this.settled.shift();
      if (this.awaiting.has(s.t)) {
        s.t.resumeWith(s.value, s.failure);
        did = true;
      }
    }
    return did;
  }
  /**
   * "Does component instance `inst` still have runnable work?" — the
   * drain-to-quiescence predicate behind the **deferred entry decision**
   * (issue #43).
   *
   * wasmtime decides an async-lowered call's initial status only after the
   * executor has drained the work queued ahead of it: a queued
   * `GuestCall(StartImplicit)` is popped, and if `is_ready` is false
   * (`do_not_enter || backpressure`) the caller is told STARTING
   * (concurrent.rs :1497-1522, :3040-3160). That formulation is FIFO-order
   * dependent; deltic uses the order-robust restatement (issue #43): *the
   * call reports STARTING only if the callee is still unstarted after the
   * instance's runnable work has been exhausted* — drain to quiescence, not
   * pop-one. That is what keeps `sync-streams.wast` green under
   * `DELTIC_SCHED_SEED` shuffles, which wasmtime's own rule would not be.
   * Adjudicated 2026-08-10 (issue #43): entry-status timing is NOT
   * normative — this predicate implements a scheduler *policy*, picked so
   * the suite's schedule-overfitted STARTED assertion holds under any
   * seed; the hold-rule gate itself is the spec semantics.
   *
   * "Runnable work of `inst`" is, exhaustively:
   *
   *   (a) a settled-but-unserviced activation tail (`settled`) — bookkeeping
   *       the reference runs atomically inside `Thread.resume`, so the
   *       instance is mid-step, not quiescent;
   *   (b) a waiting entry (thread or `SuspensionPoint`) of `inst` that is
   *       `ready()` — the scheduler will resume it on the next tick. A gate
   *       holder parked mid-frame on an un-rendezvous'd operation is NOT
   *       ready and therefore contributes nothing: that is the "holder
   *       cannot be drained" case, whose answer is STARTING;
   *   (c) a thread of `inst` in `awaiting` whose promise is not a scheduler
   *       park — i.e. genuinely in flight across an engine microtask hop.
   *       A JSPI-parked activation appears in `awaiting` *and* owns a
   *       `SuspensionPoint` in `waiting` (`SuspensionPoint.owner`), and is
   *       accounted for by (b) instead; counting it here would make the
   *       instance permanently non-quiescent.
   *
   * `excludeTask` is the CALLER's task, and is excluded everywhere: the
   * caller cannot be drained — it is the activation asking the question.
   * This is what makes the "only obstacle is the current running activation"
   * shape (a nested lower from inside the gate holder's own invocation)
   * answer STARTING immediately, with no park at all.
   */
  hasRunnableWork(inst, excludeTask) {
    const instOf = (x) => x?.task?.inst;
    const mine = (x) => instOf(x) === inst && x?.task !== excludeTask;
    for (const s of this.settled) {
      if (mine(s.t)) return true;
    }
    for (const w of this.waiting) {
      if (mine(w) && w.ready()) return true;
    }
    if (this.awaiting.size === 0) return false;
    const parked = /* @__PURE__ */ new Set();
    for (const w of this.waiting) {
      const owner = w.owner;
      if (owner !== void 0 && owner !== null) parked.add(owner);
    }
    for (const t of this.awaiting) {
      if (mine(t) && !parked.has(t)) return true;
    }
    return false;
  }
  /**
   * definitions.py `Store.tick` (line 597): resume one ready thread, bracketed
   * by the reentrance gate for a host-initiated entry (`enter_from(None)` /
   * `leave_to(None)`).
   *
   * Returns false when no thread was ready, so callers can distinguish
   * "made progress" from "stuck" without inspecting the queue themselves.
   */
  tick() {
    if (resumingThread !== null) return false;
    if (this.settled.length > 0) return false;
    const candidates = this.readyCandidates();
    if (candidates.length === 0) return false;
    const thread = chooseCandidate(candidates);
    const inst = thread.task.inst;
    assert_(inst.mayEnterFrom(null), "tick: waiting thread's instance is not enterable from the host");
    inst.enterFrom(null);
    try {
      thread.resume();
    } catch (e) {
      if (e instanceof NeedsJspi || e instanceof PendingCapability) {
        inst.leaveTo(null);
      }
      throw e;
    }
    inst.leaveTo(null);
    return true;
  }
};
function driveSyncLift(task) {
  while (task.state !== "resolved") {
    const candidates = [
      ...task.inst.threads
    ].filter((t) => t.ready() && t !== task.inst.exclusiveThread);
    trapIf(candidates.length === 0, "deadlock: synchronous task cannot resolve and no thread is ready");
    chooseCandidate(candidates).resume();
  }
}

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/runtime/src/task/waitable.ts
var EventCode = /* @__PURE__ */ function(EventCode2) {
  EventCode2[EventCode2["NONE"] = 0] = "NONE";
  EventCode2[EventCode2["SUBTASK"] = 1] = "SUBTASK";
  EventCode2[EventCode2["STREAM_READ"] = 2] = "STREAM_READ";
  EventCode2[EventCode2["STREAM_WRITE"] = 3] = "STREAM_WRITE";
  EventCode2[EventCode2["FUTURE_READ"] = 4] = "FUTURE_READ";
  EventCode2[EventCode2["FUTURE_WRITE"] = 5] = "FUTURE_WRITE";
  EventCode2[EventCode2["TASK_CANCELLED"] = 6] = "TASK_CANCELLED";
  return EventCode2;
}({});
var NO_EVENT = [
  EventCode.NONE,
  0,
  0
];
var Waitable = class {
  pendingEvent = null;
  wset = null;
  hasSyncWaiter = false;
  setPendingEvent(pendingEvent) {
    this.pendingEvent = pendingEvent;
  }
  hasPendingEvent() {
    return this.pendingEvent !== null;
  }
  inWaitableSet() {
    return this.wset !== null;
  }
  /**
   * definitions.py `Waitable.wait_for_pending_event` (line 786): a
   * *non-cancellable* block until this waitable has an event, used by the
   * synchronous `subtask.cancel` path.
   */
  *waitForPendingEvent(thread) {
    assert_(!this.inWaitableSet() && !this.hasSyncWaiter, "waitForPendingEvent on a joined or already-awaited waitable");
    this.hasSyncWaiter = true;
    yield* thread.waitUntil(() => this.hasPendingEvent(), false);
    this.hasSyncWaiter = false;
  }
  getPendingEvent() {
    const pendingEvent = this.pendingEvent;
    assert_(pendingEvent !== null, "getPendingEvent with no pending event");
    this.pendingEvent = null;
    return pendingEvent();
  }
  /** definitions.py `Waitable.join` (line 797). */
  join(wset) {
    assert_(!this.hasSyncWaiter, "join on a waitable with a sync waiter");
    if (this.wset) {
      const i = this.wset.elems.indexOf(this);
      assert_(i !== -1, "waitable not in its own waitable set");
      this.wset.elems.splice(i, 1);
    }
    this.wset = wset;
    if (wset) wset.elems.push(this);
  }
  /** definitions.py `Waitable.drop` (line 805). */
  drop() {
    assert_(!this.hasPendingEvent(), "dropping a waitable with a pending event");
    assert_(!this.hasSyncWaiter, "dropping a waitable with a sync waiter");
    this.join(null);
  }
};
var EV_TRACE = (() => {
  try {
    return Deno.env.get("CE_EVENT_TRACE") === "1";
  } catch {
    return false;
  }
})();
var WaitableSet = class {
  elems = [];
  numWaiting = 0;
  hasPendingEvent() {
    return this.elems.some((w) => w.hasPendingEvent());
  }
  /**
   * definitions.py `WaitableSet.get_pending_event` (line 821). The reference
   * shuffles `elems` before scanning; we scan in **join order** under the
   * default FIFO policy (`chooseCandidate` over the ready elements), which is
   * within the same allowed nondeterminism — see scheduler.ts's policy note.
   */
  getPendingEvent() {
    const ready2 = this.elems.filter((w2) => w2.hasPendingEvent());
    assert_(ready2.length > 0, "getPendingEvent on a set with no pending event");
    const w = chooseCandidate(ready2);
    assert_(w.wset === this, "waitable/waitable-set back-reference mismatch");
    const ev = w.getPendingEvent();
    if (EV_TRACE) {
      console.error(`[event] deliver code=${ev[0]} idx=${ev[1]} payload=${ev[2]} readyCount=${ready2.length} setSize=${this.elems.length} chosenPos=${this.elems.indexOf(w)}`);
    }
    return ev;
  }
  /** definitions.py `WaitableSet.wait_for_event_and` (line 829). */
  *waitForEventAnd(thread, readyFunc, cancellable) {
    this.numWaiting += 1;
    try {
      const cancelled = yield* thread.waitUntil(() => readyFunc() && this.hasPendingEvent(), cancellable);
      return cancelled ? [
        EventCode.TASK_CANCELLED,
        0,
        0
      ] : this.getPendingEvent();
    } finally {
      this.numWaiting -= 1;
    }
  }
  /** definitions.py `WaitableSet.wait_for_event` (line 841). */
  *waitForEvent(thread, cancellable) {
    return yield* this.waitForEventAnd(thread, () => true, cancellable);
  }
  /**
   * definitions.py `WaitableSet.poll` (line 844). Never blocks, so it is a
   * plain function rather than a generator.
   */
  // deno-lint-ignore no-explicit-any
  poll(task, cancellable) {
    if (task.deliverPendingCancel(cancellable)) {
      return [
        EventCode.TASK_CANCELLED,
        0,
        0
      ];
    }
    if (!this.hasPendingEvent()) return [
      EventCode.NONE,
      0,
      0
    ];
    return this.getPendingEvent();
  }
  /** definitions.py `WaitableSet.drop` (line 852). */
  drop() {
    trapIf(this.elems.length > 0, "cannot drop waitable set with waitables");
    trapIf(this.numWaiting > 0, "cannot drop waitable set with waiters");
  }
};

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/runtime/src/task/streams.ts
function sameElemType(a, b) {
  if (a === null || b === null) return a === b;
  return valTypeEqual(a, b);
}
var BUFFER_MAX_LENGTH = 2 ** 28 - 1;
var CopyResult = /* @__PURE__ */ function(CopyResult2) {
  CopyResult2[CopyResult2["COMPLETED"] = 0] = "COMPLETED";
  CopyResult2[CopyResult2["DROPPED"] = 1] = "DROPPED";
  CopyResult2[CopyResult2["CANCELLED"] = 2] = "CANCELLED";
  return CopyResult2;
}({});
var CopyState = /* @__PURE__ */ function(CopyState2) {
  CopyState2[CopyState2["IDLE"] = 1] = "IDLE";
  CopyState2[CopyState2["COPYING"] = 2] = "COPYING";
  CopyState2[CopyState2["CANCELLING_COPY"] = 3] = "CANCELLING_COPY";
  CopyState2[CopyState2["DONE"] = 4] = "DONE";
  return CopyState2;
}({});
var GuestBuffer = class {
  t;
  cx;
  ptr;
  length;
  progress;
  constructor(t, cx, ptr, length) {
    this.t = t;
    this.cx = cx;
    this.ptr = ptr;
    this.length = length;
    this.progress = 0;
    trapIf(length > BUFFER_MAX_LENGTH, "buffer length exceeds MAX_LENGTH");
    if (t !== null && length > 0) {
      const mem = cx.opts.memory;
      assert_(mem !== null, "buffer requires a memory");
      const ptrType = mem.ptrType();
      trapIf(ptr !== alignTo(ptr, alignment(t, ptrType)), "unaligned buffer pointer");
      trapIf(ptr + length * elemSize(t, ptrType) > mem.length, "buffer out of bounds");
    }
  }
  remain() {
    return this.length - this.progress;
  }
  isZeroLength() {
    return this.length === 0;
  }
  /** definitions.py `ReadableBufferGuestImpl.read`. */
  read(n) {
    assert_(n <= this.remain(), "buffer read beyond remaining");
    let vs;
    if (this.t !== null) {
      vs = loadListFromValidRange(this.cx, this.ptr, n, this.t);
      this.ptr += n * elemSize(this.t, this.cx.opts.memory.ptrType());
    } else {
      vs = new Array(n).fill(null);
    }
    this.progress += n;
    return vs;
  }
  /** definitions.py `WritableBufferGuestImpl.write`. */
  write(vs) {
    assert_(vs.length <= this.remain(), "buffer write beyond remaining");
    if (this.t !== null) {
      storeListIntoValidRange(this.cx, vs, this.ptr, this.t);
      this.ptr += vs.length * elemSize(this.t, this.cx.opts.memory.ptrType());
    } else {
      assert_(vs.every((v) => v === null), "zero-width buffer written with a non-empty element");
    }
    this.progress += vs.length;
  }
};
function noneOrNumberType(t) {
  if (t === null) return true;
  switch (despecialize(t).kind) {
    case "u8":
    case "u16":
    case "u32":
    case "u64":
    case "s8":
    case "s16":
    case "s32":
    case "s64":
    case "f32":
    case "f64":
      return true;
    default:
      return false;
  }
}
var SharedStreamImpl = class {
  t;
  /**
   * Optional hook fired when this shared object is lowered into a component
   * instance (`lower_stream`/`lower_future`). Host-owned ends use it to learn
   * which `Store` is driving the guest they were just handed to; guest-owned
   * streams leave it unset. Keeps `cabi` free of any host-stream knowledge.
   */
  onLowered;
  /**
   * The `Store` driving the component this object has been handed to, set the
   * first time it is lifted or lowered. Host ends need it to pump the guest
   * between export calls (see exec/host_streams.ts `HostActivity.pump`); a
   * purely guest-to-guest stream never reads it.
   */
  boundStore;
  dropped;
  pendingInst;
  pendingBuffer;
  pendingOnCopy;
  pendingOnCopyDone;
  constructor(t) {
    this.t = t;
    this.onLowered = null;
    this.boundStore = null;
    this.dropped = false;
    this.pendingInst = null;
    this.pendingBuffer = null;
    this.pendingOnCopy = null;
    this.pendingOnCopyDone = null;
  }
  resetPending() {
    this.setPending(null, null, null, null);
  }
  setPending(inst, buffer, onCopy, onCopyDone) {
    this.pendingInst = inst;
    this.pendingBuffer = buffer;
    this.pendingOnCopy = onCopy;
    this.pendingOnCopyDone = onCopyDone;
  }
  resetAndNotifyPending(result) {
    const done = this.pendingOnCopyDone;
    assert_(done !== null, "reset_and_notify_pending with nothing pending");
    this.resetPending();
    done(result);
  }
  cancel() {
    this.resetAndNotifyPending(CopyResult.CANCELLED);
  }
  drop() {
    if (!this.dropped) {
      this.dropped = true;
      if (this.pendingBuffer) this.resetAndNotifyPending(CopyResult.DROPPED);
    }
  }
  /** definitions.py `SharedStreamImpl.read` (line 1032). */
  read(inst, dstBuffer, onCopy, onCopyDone) {
    if (this.dropped) {
      onCopyDone(CopyResult.DROPPED);
    } else if (!this.pendingBuffer) {
      this.setPending(inst, dstBuffer, onCopy, onCopyDone);
    } else {
      this.#assertSameElemType(dstBuffer);
      this.#trapOnSameInstance(inst);
      if (this.pendingBuffer.remain() > 0) {
        if (dstBuffer.remain() > 0) {
          const n = Math.min(dstBuffer.remain(), this.pendingBuffer.remain());
          dstBuffer.write(this.pendingBuffer.read(n));
          this.pendingOnCopy(() => this.resetPending());
        }
        onCopyDone(CopyResult.COMPLETED);
      } else {
        this.resetAndNotifyPending(CopyResult.COMPLETED);
        this.setPending(inst, dstBuffer, onCopy, onCopyDone);
      }
    }
  }
  /** definitions.py `SharedStreamImpl.write` (line 1050). */
  write(inst, srcBuffer, onCopy, onCopyDone) {
    if (this.dropped) {
      onCopyDone(CopyResult.DROPPED);
    } else if (!this.pendingBuffer) {
      this.setPending(inst, srcBuffer, onCopy, onCopyDone);
    } else {
      this.#assertSameElemType(srcBuffer);
      this.#trapOnSameInstance(inst);
      if (this.pendingBuffer.remain() > 0) {
        if (srcBuffer.remain() > 0) {
          const n = Math.min(srcBuffer.remain(), this.pendingBuffer.remain());
          this.pendingBuffer.write(srcBuffer.read(n));
          this.pendingOnCopy(() => this.resetPending());
        }
        onCopyDone(CopyResult.COMPLETED);
      } else if (srcBuffer.isZeroLength() && this.pendingBuffer.isZeroLength()) {
        onCopyDone(CopyResult.COMPLETED);
      } else {
        this.resetAndNotifyPending(CopyResult.COMPLETED);
        this.setPending(inst, srcBuffer, onCopy, onCopyDone);
      }
    }
  }
  #assertSameElemType(b) {
    assert_(sameElemType(this.t, b.t) && sameElemType(b.t, this.pendingBuffer.t), "stream element type mismatch between ends");
  }
  /**
   * definitions.py marks this `# temporary`: a same-instance copy of a
   * non-number element type would need the source and destination lifts to
   * interleave, which the reference has not specified yet.
   */
  #trapOnSameInstance(inst) {
    trapIf(inst === this.pendingInst && !noneOrNumberType(this.t), "cannot read from and write to intra-component stream");
  }
};
var SharedFutureImpl = class {
  t;
  /**
   * Optional hook fired when this shared object is lowered into a component
   * instance (`lower_stream`/`lower_future`). Host-owned ends use it to learn
   * which `Store` is driving the guest they were just handed to; guest-owned
   * streams leave it unset. Keeps `cabi` free of any host-stream knowledge.
   */
  onLowered;
  /**
   * The `Store` driving the component this object has been handed to, set the
   * first time it is lifted or lowered. Host ends need it to pump the guest
   * between export calls (see exec/host_streams.ts `HostActivity.pump`); a
   * purely guest-to-guest stream never reads it.
   */
  boundStore;
  dropped;
  pendingInst;
  pendingBuffer;
  pendingOnCopyDone;
  constructor(t) {
    this.t = t;
    this.onLowered = null;
    this.boundStore = null;
    this.dropped = false;
    this.pendingInst = null;
    this.pendingBuffer = null;
    this.pendingOnCopyDone = null;
  }
  resetPending() {
    this.setPending(null, null, null);
  }
  setPending(inst, buffer, onCopyDone) {
    this.pendingInst = inst;
    this.pendingBuffer = buffer;
    this.pendingOnCopyDone = onCopyDone;
  }
  resetAndNotifyPending(result) {
    const done = this.pendingOnCopyDone;
    assert_(done !== null, "reset_and_notify_pending with nothing pending");
    this.resetPending();
    done(result);
  }
  cancel() {
    this.resetAndNotifyPending(CopyResult.CANCELLED);
  }
  drop() {
    if (!this.dropped) {
      this.dropped = true;
      if (this.pendingBuffer) this.resetAndNotifyPending(CopyResult.DROPPED);
    }
  }
  read(inst, dstBuffer, onCopyDone) {
    assert_(!this.dropped && dstBuffer.remain() === 1, "future read shape");
    if (!this.pendingBuffer) {
      this.setPending(inst, dstBuffer, onCopyDone);
    } else {
      trapIf(inst === this.pendingInst && !noneOrNumberType(this.t), "cannot read from and write to intra-component future");
      dstBuffer.write(this.pendingBuffer.read(1));
      this.resetAndNotifyPending(CopyResult.COMPLETED);
      onCopyDone(CopyResult.COMPLETED);
    }
  }
  write(inst, srcBuffer, onCopyDone) {
    assert_(srcBuffer.remain() === 1, "future write shape");
    if (this.dropped) {
      onCopyDone(CopyResult.DROPPED);
    } else if (!this.pendingBuffer) {
      this.setPending(inst, srcBuffer, onCopyDone);
    } else {
      trapIf(inst === this.pendingInst && !noneOrNumberType(this.t), "cannot read from and write to intra-component future");
      this.pendingBuffer.write(srcBuffer.read(1));
      this.resetAndNotifyPending(CopyResult.COMPLETED);
      onCopyDone(CopyResult.COMPLETED);
    }
  }
};
var CopyEnd = class extends Waitable {
  shared;
  state;
  constructor(shared) {
    super(), this.shared = shared, this.state = CopyState.IDLE;
  }
  copying() {
    return this.state === CopyState.COPYING || this.state === CopyState.CANCELLING_COPY;
  }
  drop() {
    trapIf(this.copying(), "cannot drop busy stream");
    this.shared.drop();
    super.drop();
  }
};
var ReadableStreamEnd = class extends CopyEnd {
  copy(inst, dst, onCopy, onCopyDone) {
    this.shared.read(inst, dst, onCopy, onCopyDone);
  }
};
var WritableStreamEnd = class extends CopyEnd {
  copy(inst, src, onCopy, onCopyDone) {
    this.shared.write(inst, src, onCopy, onCopyDone);
  }
};
var ReadableFutureEnd = class extends CopyEnd {
  copy(inst, dst, onCopyDone) {
    this.shared.read(inst, dst, onCopyDone);
  }
};
var WritableFutureEnd = class extends CopyEnd {
  copy(inst, src, onCopyDone) {
    this.shared.write(inst, src, onCopyDone);
  }
  /**
   * definitions.py `WritableFutureEnd.drop` (line 1183): a future's writable
   * end may only be dropped once it has actually delivered its one value —
   * `test/async/futures-must-write.wast` is the case this exists for.
   */
  drop() {
    trapIf(this.state !== CopyState.DONE, "cannot drop future write end without first writing a value");
    super.drop();
  }
};
var ErrorContext = class {
  debugMessage;
  constructor(debugMessage) {
    this.debugMessage = debugMessage;
  }
};

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/runtime/src/cabi/async_values.ts
function containsBorrow(t) {
  return contains(t, (x) => x.kind === "borrow");
}
function liftAsyncValue(cx, i, t, EndT, elem, what) {
  assert_(!containsBorrow(t), `${what} may not contain a borrow`);
  const inst = cx.inst;
  assert_(inst !== null, `${what} lift requires a component instance`);
  const e = inst.handles.remove(i);
  trapIf(!(e instanceof EndT), `${what} lift: handle is not a ${what} end`);
  const end = e;
  trapIf(!sameElemType(end.shared.t, elem), `${what} lift: element type mismatch`);
  trapIf(end.state === CopyState.DONE, what === "future" ? "cannot lift future after previous read succeeded" : "cannot lift stream after being notified that the writable end dropped");
  trapIf(end.state !== CopyState.IDLE, `cannot remove busy ${what}`);
  trapIf(end.inWaitableSet(), `cannot lift ${what} while it's in a waitable set`);
  const holder = end.shared;
  const store2 = inst.store;
  if (holder.boundStore != null && store2 != null) {
    assert_(holder.boundStore === store2, `${what} crossed into a second store; multi-store is unsupported`);
  }
  holder.boundStore ??= store2;
  return end.shared;
}
function liftStream(cx, i, t) {
  return liftAsyncValue(cx, i, t, ReadableStreamEnd, t.element, "stream");
}
function liftFuture(cx, i, t) {
  return liftAsyncValue(cx, i, t, ReadableFutureEnd, t.element, "future");
}
function lowerStream(cx, v, t) {
  assert_(v instanceof SharedStreamImpl, "lower_stream expects a shared stream value");
  assert_(!containsBorrow(t), "stream may not contain a borrow");
  const declared = t.element ?? null;
  if (!sameElemType(v.t, declared)) {
    assert_(false, `stream element type mismatch: host end carries ${fmtValType(v.t)}, callee expects ${fmtValType(declared)}`);
  }
  const inst = cx.inst;
  assert_(inst !== null, "stream lower requires a component instance");
  v.boundStore ??= inst.store;
  v.onLowered?.(inst);
  return inst.handles.add(new ReadableStreamEnd(v));
}
function lowerFuture(cx, v, t) {
  assert_(v instanceof SharedFutureImpl, "lower_future expects a shared future value");
  assert_(!containsBorrow(t), "future may not contain a borrow");
  const declared = t.element ?? null;
  if (!sameElemType(v.t, declared)) {
    assert_(false, `future element type mismatch: host end carries ${fmtValType(v.t)}, callee expects ${fmtValType(declared)}`);
  }
  const inst = cx.inst;
  assert_(inst !== null, "future lower requires a component instance");
  v.boundStore ??= inst.store;
  v.onLowered?.(inst);
  return inst.handles.add(new ReadableFutureEnd(v));
}
function liftErrorContext(cx, i) {
  const inst = cx.inst;
  assert_(inst !== null, "error-context lift requires a component instance");
  const e = inst.handles.get(i);
  trapIf(!(e instanceof ErrorContext), "error-context lift: handle is not an error-context");
  return e;
}
function lowerErrorContext(cx, v) {
  const inst = cx.inst;
  assert_(inst !== null, "error-context lower requires a component instance");
  return inst.handles.add(v);
}

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/runtime/src/cabi/load.ts
var MAX_LIST_BYTE_LENGTH = (1 << 28) - 1;
function load(cx, ptr, t) {
  const mem = requireMemory(cx.opts);
  assert_(ptr === alignTo(ptr, alignment(t, mem.ptrType())), "load misaligned");
  assert_(ptr + elemSize(t, mem.ptrType()) <= mem.length, "load OOB");
  const d = despecialize(t);
  switch (d.kind) {
    case "bool":
      return convertIntToBool(loadIntU(mem, ptr, 1));
    case "u8":
      return loadIntU(mem, ptr, 1);
    case "u16":
      return loadIntU(mem, ptr, 2);
    case "u32":
      return loadIntU(mem, ptr, 4);
    case "u64":
      return loadIntU(mem, ptr, 8);
    case "s8":
      return loadIntS(mem, ptr, 1);
    case "s16":
      return loadIntS(mem, ptr, 2);
    case "s32":
      return loadIntS(mem, ptr, 4);
    case "s64":
      return loadIntS(mem, ptr, 8);
    case "f32":
      return decodeI32AsFloat(loadIntU(mem, ptr, 4));
    case "f64":
      return decodeI64AsFloat(loadIntU(mem, ptr, 8));
    case "char":
      return convertI32ToChar(loadIntU(mem, ptr, 4));
    case "string":
      return loadString(cx, ptr);
    case "error-context":
      return liftErrorContext(cx, loadIntU(cx.opts.memory, ptr, 4));
    case "list":
      return loadList(cx, ptr, d.element, d.length ?? null);
    case "record":
      return loadRecord(cx, ptr, d.fields);
    case "variant":
      return loadVariant(cx, ptr, d.cases);
    case "flags":
      return loadFlags(cx, ptr, d.labels);
    case "own":
      return liftOwn(cx, loadIntU(mem, ptr, 4), d);
    case "borrow":
      return liftBorrow(cx, loadIntU(mem, ptr, 4), d);
    case "stream":
      return liftStream(cx, loadIntU(cx.opts.memory, ptr, 4), d);
    case "future":
      return liftFuture(cx, loadIntU(cx.opts.memory, ptr, 4), d);
  }
}
function convertIntToBool(i) {
  assert_(i >= 0);
  return Boolean(i);
}
function loadList(cx, ptr, elemType, maybeLength) {
  if (maybeLength !== null) {
    return loadListFromValidRange(cx, ptr, maybeLength, elemType);
  }
  const mem = requireMemory(cx.opts);
  const begin = loadPtr(mem, ptr);
  const length = loadPtr(mem, ptr + mem.ptrSize());
  return loadListFromRange(cx, begin, length, elemType);
}
function loadListFromRange(cx, ptr, length, elemType) {
  const mem = requireMemory(cx.opts);
  const size = elemSize(elemType, mem.ptrType());
  const align = alignment(elemType, mem.ptrType());
  const byteLengthBig = BigInt(length) * BigInt(size);
  trapIf(byteLengthBig > BigInt(MAX_LIST_BYTE_LENGTH), "list too long");
  const ptrBig = BigInt(ptr);
  trapIf(ptrBig % BigInt(align) !== 0n, "misaligned list pointer");
  trapIf(ptrBig + byteLengthBig > BigInt(mem.length), "list out of bounds");
  return loadListFromValidRange(cx, Number(ptrBig), Number(length), elemType);
}
function loadListFromValidRange(cx, ptr, length, elemType) {
  const mem = requireMemory(cx.opts);
  if (despecialize(elemType).kind === "u8") {
    return bytesOf(mem, ptr, length).slice();
  }
  const size = elemSize(elemType, mem.ptrType());
  const a = [];
  for (let i = 0; i < length; i++) {
    a.push(load(cx, ptr + i * size, elemType));
  }
  return a;
}
function loadRecord(cx, ptr, fields) {
  const mem = requireMemory(cx.opts);
  const record = {};
  let p = ptr;
  for (const field of fields) {
    p = alignTo(p, alignment(field.type, mem.ptrType()));
    record[field.label] = load(cx, p, field.type);
    p += elemSize(field.type, mem.ptrType());
  }
  return record;
}
function loadVariant(cx, ptr, cases) {
  const mem = requireMemory(cx.opts);
  const discSize = elemSize(discriminantType(cases), mem.ptrType());
  const caseIndex = loadIntU(mem, ptr, discSize);
  let p = ptr + discSize;
  trapIf(caseIndex >= cases.length, "invalid variant discriminant");
  const c = cases[caseIndex];
  p = alignTo(p, maxCaseAlignment(cases, mem.ptrType()));
  if (c.type === null) return {
    [c.label]: null
  };
  return {
    [c.label]: load(cx, p, c.type)
  };
}
function loadFlags(cx, ptr, labels) {
  const mem = requireMemory(cx.opts);
  const i = loadIntU(mem, ptr, elemSizeFlags(labels));
  return unpackFlagsFromInt(i, labels);
}
function unpackFlagsFromInt(i, labels) {
  const record = {};
  let v = i >>> 0;
  for (const l of labels) {
    record[l] = Boolean(v & 1);
    v = v >>> 1;
  }
  return record;
}

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/runtime/src/cabi/flatten.ts
var MAX_FLAT_PARAMS = 16;
var MAX_FLAT_ASYNC_PARAMS = 4;
var MAX_FLAT_RESULTS = 1;
function flattenFunctype(opts, ft, context) {
  let flatParams = flattenTypes(ft.params, opts);
  let flatResults = flattenTypes(ft.results, opts);
  if (!opts.async_) {
    if (flatParams.length > MAX_FLAT_PARAMS) {
      flatParams = [
        requireMemory(opts).ptrType()
      ];
    }
    if (flatResults.length > MAX_FLAT_RESULTS) {
      switch (context) {
        case "lift":
          flatResults = [
            requireMemory(opts).ptrType()
          ];
          break;
        case "lower":
          flatParams = [
            ...flatParams,
            requireMemory(opts).ptrType()
          ];
          flatResults = [];
          break;
      }
    }
    return {
      params: flatParams,
      results: flatResults
    };
  } else {
    switch (context) {
      case "lift":
        if (flatParams.length > MAX_FLAT_PARAMS) {
          flatParams = [
            requireMemory(opts).ptrType()
          ];
        }
        if (opts.callback) {
          flatResults = [
            "i32"
          ];
        } else {
          flatResults = [];
        }
        break;
      case "lower":
        if (flatParams.length > MAX_FLAT_ASYNC_PARAMS) {
          flatParams = [
            requireMemory(opts).ptrType()
          ];
        }
        if (flatResults.length > 0) {
          flatParams = [
            ...flatParams,
            requireMemory(opts).ptrType()
          ];
        }
        flatResults = [
          "i32"
        ];
        break;
    }
    return {
      params: flatParams,
      results: flatResults
    };
  }
}
function flattenTypes(ts, opts) {
  return ts.flatMap((t) => flattenType(t, opts));
}
function flattenType(t, opts) {
  const d = despecialize(t);
  switch (d.kind) {
    case "bool":
    case "u8":
    case "u16":
    case "u32":
    case "s8":
    case "s16":
    case "s32":
    case "char":
      return [
        "i32"
      ];
    case "s64":
    case "u64":
      return [
        "i64"
      ];
    case "f32":
      return [
        "f32"
      ];
    case "f64":
      return [
        "f64"
      ];
    case "string": {
      const pt = requireMemory(opts).ptrType();
      return [
        pt,
        pt
      ];
    }
    case "error-context":
      return [
        "i32"
      ];
    case "list":
      return flattenList(d.element, d.length ?? null, opts);
    case "record":
      return flattenRecord(d.fields, opts);
    case "variant":
      return flattenVariant(d.cases, opts);
    case "flags":
      return [
        "i32"
      ];
    case "own":
    case "borrow":
    case "stream":
    case "future":
      return [
        "i32"
      ];
  }
}
function flattenList(elemType, maybeLength, opts) {
  if (maybeLength !== null) {
    const flat = [];
    const one = flattenType(elemType, opts);
    for (let i = 0; i < maybeLength; i++) flat.push(...one);
    return flat;
  }
  const pt = requireMemory(opts).ptrType();
  return [
    pt,
    pt
  ];
}
function flattenRecord(fields, opts) {
  const flat = [];
  for (const f of fields) flat.push(...flattenType(f.type, opts));
  return flat;
}
function flattenVariant(cases, opts) {
  const flat = [];
  for (const c of cases) {
    if (c.type !== null) {
      flattenType(c.type, opts).forEach((ft, i) => {
        if (i < flat.length) {
          flat[i] = join(flat[i], ft);
        } else {
          flat.push(ft);
        }
      });
    }
  }
  return [
    ...flattenType(discriminantType(cases), opts),
    ...flat
  ];
}
function join(a, b) {
  if (a === b) return a;
  if (a === "i32" && b === "f32" || a === "f32" && b === "i32") {
    return "i32";
  }
  return "i64";
}

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/runtime/src/cabi/lift.ts
var CoreValueIter = class {
  values;
  i;
  constructor(values) {
    this.values = values;
    this.i = 0;
  }
  next(t) {
    const v = this.values[this.i];
    this.i += 1;
    switch (t) {
      case "i32":
        assert_(typeof v === "number" && Number.isInteger(v) && 0 <= v && v < 2 ** 32, "expected canonical i32 lane value");
        break;
      case "i64":
        assert_(typeof v === "bigint" && 0n <= v && v < 1n << 64n, "expected canonical i64 lane value");
        break;
      case "f32":
      case "f64":
        assert_(typeof v === "number", "expected float lane value");
        break;
    }
    return v;
  }
  done() {
    return this.i === this.values.length;
  }
};
function liftFlat(cx, vi, t) {
  const d = despecialize(t);
  switch (d.kind) {
    case "bool":
      return convertIntToBool(vi.next("i32"));
    case "u8":
      return liftFlatUnsigned32(vi, 8);
    case "u16":
      return liftFlatUnsigned32(vi, 16);
    case "u32":
      return liftFlatUnsigned32(vi, 32);
    case "u64":
      return liftFlatUnsigned64(vi);
    case "s8":
      return liftFlatSigned32(vi, 8);
    case "s16":
      return liftFlatSigned32(vi, 16);
    case "s32":
      return liftFlatSigned32(vi, 32);
    case "s64":
      return liftFlatSigned64(vi);
    case "f32":
      return canonicalizeNan32(vi.next("f32"));
    case "f64":
      return canonicalizeNan64(vi.next("f64"));
    case "char":
      return convertI32ToChar(vi.next("i32"));
    case "string":
      return liftFlatString(cx, vi);
    case "error-context":
      return liftErrorContext(cx, vi.next("i32"));
    case "list":
      return liftFlatList(cx, vi, d.element, d.length ?? null);
    case "record":
      return liftFlatRecord(cx, vi, d.fields);
    case "variant":
      return liftFlatVariant(cx, vi, d.cases);
    case "flags":
      return liftFlatFlags(vi, d.labels);
    case "own":
      return liftOwn(cx, vi.next("i32"), d);
    case "borrow":
      return liftBorrow(cx, vi.next("i32"), d);
    case "stream":
      return liftStream(cx, vi.next("i32"), d);
    case "future":
      return liftFuture(cx, vi.next("i32"), d);
  }
}
function liftFlatUnsigned32(vi, tWidth) {
  const i = vi.next("i32");
  assert_(0 <= i && i < 2 ** 32);
  return i % 2 ** tWidth;
}
function liftFlatUnsigned64(vi) {
  const i = vi.next("i64");
  assert_(0n <= i && i < 1n << 64n);
  return i;
}
function liftFlatSigned32(vi, tWidth) {
  const i0 = vi.next("i32");
  assert_(0 <= i0 && i0 < 2 ** 32);
  const i = i0 % 2 ** tWidth;
  if (i >= 2 ** (tWidth - 1)) {
    return i - 2 ** tWidth;
  }
  return i;
}
function liftFlatSigned64(vi) {
  const i = vi.next("i64");
  assert_(0n <= i && i < 1n << 64n);
  if (i >= 1n << 63n) {
    return i - (1n << 64n);
  }
  return i;
}
function liftFlatString(cx, vi) {
  const ptrType = requireMemory(cx.opts).ptrType();
  const ptr = vi.next(ptrType);
  const packedLength = vi.next(ptrType);
  return loadStringFromRange(cx, ptr, packedLength);
}
function liftFlatList(cx, vi, elemType, maybeLength) {
  if (maybeLength !== null) {
    const a = [];
    for (let i = 0; i < maybeLength; i++) {
      a.push(liftFlat(cx, vi, elemType));
    }
    if (despecialize(elemType).kind === "u8") {
      return Uint8Array.from(a);
    }
    return a;
  }
  const ptrType = requireMemory(cx.opts).ptrType();
  const ptr = vi.next(ptrType);
  const length = vi.next(ptrType);
  return loadListFromRange(cx, ptr, length, elemType);
}
function liftFlatRecord(cx, vi, fields) {
  const record = {};
  for (const f of fields) {
    record[f.label] = liftFlat(cx, vi, f.type);
  }
  return record;
}
function liftFlatVariant(cx, vi, cases) {
  const flatTypes = flattenVariant(cases, cx.opts);
  assert_(flatTypes.shift() === "i32");
  const caseIndex = vi.next("i32");
  trapIf(caseIndex >= cases.length, "invalid variant discriminant");
  const coerceIter = {
    next(want) {
      const have = flatTypes.shift();
      const x = vi.next(have);
      if (have === "i32" && want === "f32") {
        return decodeI32AsFloat(x);
      } else if (have === "i64" && want === "i32") {
        return wrapI64ToI32(x);
      } else if (have === "i64" && want === "f32") {
        return decodeI32AsFloat(wrapI64ToI32(x));
      } else if (have === "i64" && want === "f64") {
        return decodeI64AsFloat(x);
      } else {
        assert_(have === want, `lane mismatch ${have} -> ${want}`);
        return x;
      }
    }
  };
  const c = cases[caseIndex];
  let v;
  if (c.type === null) {
    v = null;
  } else {
    v = liftFlat(cx, coerceIter, c.type);
  }
  for (const have of flatTypes) {
    vi.next(have);
  }
  return {
    [c.label]: v
  };
}
function wrapI64ToI32(i) {
  assert_(0n <= i && i < 1n << 64n);
  return Number(i & 0xffffffffn);
}
function liftFlatFlags(vi, labels) {
  assert_(0 < labels.length && labels.length <= 32);
  const i = vi.next("i32");
  return unpackFlagsFromInt(i, labels);
}

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/runtime/src/cabi/lower.ts
function lowerFlat(cx, v, t) {
  const d = despecialize(t);
  switch (d.kind) {
    case "bool":
      return [
        Number(v)
      ];
    case "u8":
    case "u16":
    case "u32":
      return [
        v
      ];
    case "u64":
      return [
        v
      ];
    case "s8":
    case "s16":
    case "s32":
      return lowerFlatSigned32(v);
    case "s64":
      return lowerFlatSigned64(v);
    case "f32":
      return [
        maybeScrambleNan32(v)
      ];
    case "f64":
      return [
        maybeScrambleNan64(v)
      ];
    case "char":
      return [
        charToI32(v)
      ];
    case "string":
      return lowerFlatString(cx, v);
    case "error-context":
      return [
        lowerErrorContext(cx, v)
      ];
    case "list":
      return lowerFlatList(cx, v, d.element, d.length ?? null);
    case "record":
      return lowerFlatRecord(cx, v, d.fields);
    case "variant":
      return lowerFlatVariant(cx, v, d.cases);
    case "flags":
      return lowerFlatFlags(v, d.labels);
    case "own":
      return [
        lowerOwn(cx, v, d)
      ];
    case "borrow":
      return [
        lowerBorrow(cx, v, d)
      ];
    case "stream":
      return [
        lowerStream(cx, v, d)
      ];
    case "future":
      return [
        lowerFuture(cx, v, d)
      ];
  }
}
function lowerFlatSigned32(i) {
  if (i < 0) {
    return [
      i + 2 ** 32
    ];
  }
  return [
    i
  ];
}
function lowerFlatSigned64(i) {
  if (i < 0n) {
    return [
      i + (1n << 64n)
    ];
  }
  return [
    i
  ];
}
function lowerFlatString(cx, v) {
  const [ptr, packedLength] = storeStringIntoRange(cx, v);
  if (requireMemory(cx.opts).ptrType() === "i32") {
    return [
      ptr,
      Number(packedLength)
    ];
  }
  return [
    BigInt(ptr),
    packedLength
  ];
}
function lowerFlatList(cx, v, elemType, maybeLength) {
  if (maybeLength !== null) {
    assert_(maybeLength === v.length, "fixed-length list length mismatch");
    const flat = [];
    for (let i = 0; i < v.length; i++) {
      flat.push(...lowerFlat(cx, v[i], elemType));
    }
    return flat;
  }
  const [ptr, length] = storeListIntoRange(cx, v, elemType);
  if (requireMemory(cx.opts).ptrType() === "i32") {
    return [
      ptr,
      length
    ];
  }
  return [
    BigInt(ptr),
    BigInt(length)
  ];
}
function lowerFlatRecord(cx, v, fields) {
  const flat = [];
  for (const f of fields) {
    flat.push(...lowerFlat(cx, v[f.label], f.type));
  }
  return flat;
}
function lowerFlatVariant(cx, v, cases) {
  const [caseIndex, caseValue] = matchCase(v, cases);
  const flatTypes = flattenVariant(cases, cx.opts);
  assert_(flatTypes.shift() === "i32");
  const c = cases[caseIndex];
  let payload;
  if (c.type === null) {
    payload = [];
  } else {
    payload = lowerFlat(cx, caseValue, c.type);
    const haveTypes = flattenType(c.type, cx.opts);
    for (let i = 0; i < payload.length; i++) {
      const fv = payload[i];
      const have = haveTypes[i];
      const want = flatTypes.shift();
      if (have === "f32" && want === "i32") {
        payload[i] = encodeFloatAsI32(fv);
      } else if (have === "i32" && want === "i64") {
        payload[i] = BigInt(fv);
      } else if (have === "f32" && want === "i64") {
        payload[i] = BigInt(encodeFloatAsI32(fv));
      } else if (have === "f64" && want === "i64") {
        payload[i] = encodeFloatAsI64(fv);
      } else {
        assert_(have === want, `lane mismatch ${have} -> ${want}`);
      }
    }
  }
  for (const want of flatTypes) {
    payload.push(want === "i64" ? 0n : 0);
  }
  return [
    caseIndex,
    ...payload
  ];
}
function lowerFlatFlags(v, labels) {
  assert_(0 < labels.length && labels.length <= 32);
  return [
    packFlagsIntoInt(v, labels)
  ];
}

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/runtime/src/cabi/values.ts
function liftFlatValues(cx, maxFlat, vi, ts) {
  const flatTypes = flattenTypes(ts, cx.opts);
  if (flatTypes.length > maxFlat) {
    const mem = requireMemory(cx.opts);
    const ptrRaw = vi.next(mem.ptrType());
    const tupleType = {
      kind: "tuple",
      elements: ts
    };
    const align = alignment(tupleType, mem.ptrType());
    const size = elemSize(tupleType, mem.ptrType());
    trapIf(BigInt(ptrRaw) % BigInt(align) !== 0n, "misaligned spill pointer");
    trapIf(BigInt(ptrRaw) + BigInt(size) > BigInt(mem.length), "spill tuple out of bounds");
    const ptr = asIndex(ptrRaw);
    const tuple = load(cx, ptr, tupleType);
    return Object.values(tuple);
  } else {
    return ts.map((t) => liftFlat(cx, vi, t));
  }
}
function lowerFlatValues(cx, maxFlat, vs, ts, outParam = null) {
  const flatTypes = flattenTypes(ts, cx.opts);
  if (flatTypes.length > maxFlat) {
    const mem = requireMemory(cx.opts);
    const tupleType = {
      kind: "tuple",
      elements: ts
    };
    const tupleValue = {};
    vs.forEach((v, i) => {
      tupleValue[String(i)] = v;
    });
    let ptr;
    let flatVals;
    const align = alignment(tupleType, mem.ptrType());
    const size = elemSize(tupleType, mem.ptrType());
    if (outParam === null) {
      ptr = cx.allocate(align, size);
      flatVals = mem.ptrType() === "i32" ? [
        ptr
      ] : [
        BigInt(ptr)
      ];
    } else {
      ptr = asIndex(outParam.next(mem.ptrType()));
      flatVals = [];
    }
    trapIf(ptr !== alignTo(ptr, align), "misaligned spill pointer");
    trapIf(ptr + size > mem.length, "spill tuple out of bounds");
    store(cx, tupleValue, tupleType, ptr);
    return flatVals;
  } else {
    const flatVals = [];
    for (let i = 0; i < vs.length; i++) {
      flatVals.push(...lowerFlat(cx, vs[i], ts[i]));
    }
    return flatVals;
  }
}

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/runtime/src/task/thread.ts
var Thread = class {
  task;
  /**
   * Per-thread context slots (definitions.py `Thread.storage`, line 323 —
   * initialised `[0,0]`). `canon_context_{get,set}` (lines 2348/2358) read and
   * write *this*, not per-task state: two threads of the same task have
   * independent context. wit-bindgen 0.60 keeps its async task pointer in
   * slot 0.
   */
  storage;
  /**
   * The FACT sync-call bracket stack for THIS activation.
   *
   * `enter-sync-call` pushes and `exit-sync-call` pops; FACT emits both from
   * the same activation, so the activation is the continuity that makes this a
   * stack. See the note on `Task.syncCallStack` for why per-task was not
   * enough.
   */
  // deno-lint-ignore no-explicit-any
  syncCallStack;
  /** Slot in `inst.threads`, assigned by `Task.registerThread`. */
  index;
  /** definitions.py `Thread.cancellable` — set at each block point. */
  cancellable;
  #state;
  #body;
  #readyFunc;
  #store;
  // deno-lint-ignore no-explicit-any
  constructor(task, body) {
    this.task = task;
    this.storage = [
      0,
      0
    ];
    this.syncCallStack = [];
    this.index = null;
    this.cancellable = false;
    this.#state = "suspended";
    this.#readyFunc = null;
    this.awaiting = null;
    this.#body = body;
    this.#store = task.inst.store;
  }
  running() {
    return this.#state === "running";
  }
  suspended() {
    return this.#state === "suspended";
  }
  waiting() {
    return this.#state === "waiting";
  }
  done() {
    return this.#state === "done";
  }
  /** definitions.py `Thread.ready` (line 334). */
  ready() {
    return this.waiting() && this.#readyFunc !== null && this.#readyFunc();
  }
  /** definitions.py `Thread.start_waiting_internal` (line 350). */
  #startWaiting(readyFunc) {
    assert_(!this.waiting() && this.#readyFunc === null);
    this.#readyFunc = readyFunc;
    this.#state = "waiting";
    this.#store.startWaiting(this);
  }
  /** definitions.py `Thread.stop_waiting_internal` (line 355). */
  #stopWaiting(cancelled) {
    assert_(this.waiting() && this.#readyFunc !== null);
    assert_(cancelled || this.ready(), "stopWaiting on a thread that is neither ready nor cancelled");
    this.#readyFunc = null;
    this.#state = "suspended";
    this.#store.stopWaiting(this);
  }
  /** definitions.py `Thread.resume_later` (line 361). */
  resumeLater() {
    assert_(this.suspended(), "resume_later on a non-suspended thread");
    this.#startWaiting(() => true);
  }
  awaiting;
  /** Resume a promise-parked thread with the settled result. */
  resumeWith(value, failure) {
    assert_(this.awaiting !== null, "resumeWith on a thread that is not awaiting");
    this.awaiting = null;
    this.#store.awaiting.delete(this);
    this.#state = "suspended";
    const inst = this.task.inst;
    assert_(inst.mayEnterFrom(null), "resumeWith: parked thread's instance is not enterable from the host");
    inst.enterFrom(null);
    try {
      this.#resumeInternal(value, failure);
    } catch (e) {
      if (e instanceof NeedsJspi || e instanceof PendingCapability) {
        inst.leaveTo(null);
      }
      throw e;
    }
    inst.leaveTo(null);
  }
  resume(cancelled = CANCELLED_FALSE) {
    assert_(!this.running() && !this.done(), "resume() on a running or finished thread");
    assert_(this.cancellable || !cancelled, "cancelled resume of a non-cancellable block point");
    if (this.waiting()) this.#stopWaiting(cancelled);
    this.#resumeInternal(cancelled);
  }
  #resumeInternal(sendValue, failure) {
    this.#state = "running";
    pushCurrentThread(this);
    let step;
    try {
      step = failure === void 0 ? this.#body.next(sendValue) : this.#body.throw(failure.error);
    } catch (e) {
      this.#state = "done";
      throw e;
    } finally {
      popCurrentThread(this);
    }
    if (step.done) {
      this.#state = "done";
      return;
    }
    const req = step.value;
    this.cancellable = req.cancellable;
    if (req.awaitValue !== void 0) {
      this.#state = "suspended";
      this.awaiting = req.awaitValue;
      this.#store.noteAwaiting(this, req.awaitValue);
      return;
    }
    if (req.readyFunc === null) {
      this.#state = "suspended";
    } else {
      this.#state = "suspended";
      this.#startWaiting(req.readyFunc);
    }
  }
  /**
   * definitions.py `Thread.wait_until` (line 396), as a generator-side helper.
   *
   * Call it from a thread body with `yield*`:
   *   `const cancelled = yield* thread.waitUntil(() => cond, true);`
   *
   * Deviation from the reference, deliberate: the reference may return
   * immediately when `ready_func()` already holds
   * (`if ready_func() and not DETERMINISTIC_PROFILE and random.randint(0,1)`).
   * We always take the blocking path, i.e. we behave as the reference's
   * `DETERMINISTIC_PROFILE`. Blocking-then-immediately-ready is observably
   * equivalent (the scheduler will find this thread ready on the next
   * candidate scan) and it removes a coin flip from every wait.
   */
  *waitUntil(readyFunc, cancellable = false) {
    assert_(this.running(), "waitUntil on a non-running thread");
    if (this.task.deliverPendingCancel(cancellable)) return CANCELLED_TRUE;
    const cancelled = yield {
      readyFunc,
      cancellable
    };
    return cancelled;
  }
  /** definitions.py `Thread.suspend` (line 390). */
  *suspend(cancellable) {
    assert_(this.running(), "suspend on a non-running thread");
    if (this.task.deliverPendingCancel(cancellable)) return CANCELLED_TRUE;
    const cancelled = yield {
      readyFunc: null,
      cancellable
    };
    return cancelled;
  }
  /** definitions.py `Thread.yield_` (line 405): `wait_until(lambda: True)`. */
  *yield_(cancellable) {
    return yield* this.waitUntil(() => true, cancellable);
  }
};

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/runtime/src/task/subtask.ts
var SubtaskState = /* @__PURE__ */ function(SubtaskState2) {
  SubtaskState2[SubtaskState2["STARTING"] = 0] = "STARTING";
  SubtaskState2[SubtaskState2["STARTED"] = 1] = "STARTED";
  SubtaskState2[SubtaskState2["RETURNED"] = 2] = "RETURNED";
  SubtaskState2[SubtaskState2["CANCELLED_BEFORE_STARTED"] = 3] = "CANCELLED_BEFORE_STARTED";
  SubtaskState2[SubtaskState2["CANCELLED_BEFORE_RETURNED"] = 4] = "CANCELLED_BEFORE_RETURNED";
  return SubtaskState2;
}({});
var Subtask = class extends Waitable {
  state = SubtaskState.STARTING;
  onCancel = null;
  cancellationRequested = false;
  flatResults = [];
  /**
   * The callee TASK behind this subtask, when there is one (FACT
   * cross-component calls; host-import subtasks have none). `subtask.cancel`
   * needs it under jspi: a cancellation delivered to a suspended activation
   * resumes it on a MICROTASK (the engine's, not ours), so the async form
   * must wait until the callee's state is determinate before choosing
   * between BLOCKED and the resolved state — the same determinacy question
   * `async-start-call` answers, and it needs the same object to ask it of.
   */
  // deno-lint-ignore no-explicit-any
  calleeTask = null;
  /**
   * Handles lent to the callee for the duration of the call. `null` once
   * `deliverResolve` has run — the reference uses exactly this
   * `lenders is None` sentinel to mean "resolve delivered" (line 908), so the
   * nullability is semantic, not an optimization.
   */
  lenders = [];
  /** definitions.py `Subtask.resolved` (line 880). */
  resolved() {
    switch (this.state) {
      case SubtaskState.STARTING:
      case SubtaskState.STARTED:
        return false;
      default:
        return true;
    }
  }
  /** definitions.py `Subtask.add_lender` (line 890). */
  addLender(h) {
    assert_(!this.resolveDelivered() && !this.resolved(), "addLender on a resolved subtask");
    h.numLends += 1;
    this.lenders.push(h);
  }
  /** definitions.py `Subtask.resolve` (line 895). */
  resolve(state, flatResults) {
    assert_(state === SubtaskState.RETURNED || flatResults.length === 0, "non-RETURNED subtask resolution carries results");
    assert_(!this.resolved(), "resolve on an already-resolved subtask");
    this.state = state;
    this.flatResults = flatResults;
  }
  /** definitions.py `Subtask.deliver_resolve` (line 902). */
  deliverResolve() {
    assert_(!this.resolveDelivered() && this.resolved(), "deliverResolve on an unresolved or already-delivered subtask");
    for (const h of this.lenders) h.numLends -= 1;
    this.lenders = null;
  }
  /** definitions.py `Subtask.resolve_delivered` (line 908). */
  resolveDelivered() {
    assert_(this.lenders !== null || this.resolved(), "lenders released on an unresolved subtask");
    return this.lenders === null;
  }
  /** definitions.py `Subtask.drop` (line 912). */
  drop() {
    trapIf(!this.resolveDelivered(), "cannot drop a subtask which has not yet resolved");
    super.drop();
  }
  /**
   * definitions.py `canon_lower`'s `on_progress`/`subtask_event` closure
   * (line 2296). The event payload is computed **at delivery time** and
   * delivering it is what runs `deliver_resolve` — so the lent handles are
   * released exactly when the guest observes the resolution, not when it
   * happens.
   */
  setSubtaskPendingEvent(subtaski) {
    this.setPendingEvent(() => {
      if (this.resolved() && !this.resolveDelivered()) this.deliverResolve();
      return [
        EventCode.SUBTASK,
        subtaski,
        this.state
      ];
    });
  }
};
function packSubtaskResult(state, subtaski) {
  assert_(subtaski > 0 && subtaski <= 2 ** 28 - 1, "subtask index out of packing range");
  assert_(state >= 0 && state < 2 ** 4, "subtask state out of packing range");
  return (state | subtaski << 4) >>> 0;
}

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/runtime/src/task/mod.ts
var ComponentInstanceState = class {
  index;
  flags;
  handles = new Table();
  /** definitions.py `ComponentInstance.threads` — a Table, so `thread.index`. */
  threads = new Table();
  mayEnter = true;
  /** definitions.py `backpressure: int` — a *counter* (backpressure.{inc,dec}). */
  backpressure = 0;
  /** definitions.py `num_waiting_to_enter`. */
  numWaitingToEnter = 0;
  /** definitions.py `exclusive_thread`. */
  exclusiveThread = null;
  /**
   * definitions.py `ComponentInstance.parent`. The plan gives us a flat
   * instance space with no nesting information, so this stays null and
   * `selfAndAncestors` degenerates to `{this}` — see `enteringSet`.
   */
  parent = null;
  store;
  constructor(index, store2) {
    this.index = index;
    this.store = store2 ?? new Store();
    this.flags = new WebAssembly.Global({
      value: "i32",
      mutable: true
    }, 1);
  }
  get mayLeave() {
    return this.flags.value !== 0;
  }
  set mayLeave(v) {
    this.flags.value = v ? 1 : 0;
  }
  /** definitions.py `ComponentInstance.self_and_ancestors` (line 236). */
  selfAndAncestors() {
    const s = /* @__PURE__ */ new Set([
      this
    ]);
    let a = this.parent;
    while (a !== null) {
      s.add(a);
      a = a.parent;
    }
    return s;
  }
  /**
   * definitions.py `ComponentInstance.entering_set` (line 230):
   * `self_and_ancestors() - caller.self_and_ancestors()`.
   *
   * CONTRACT / KNOWN UNSOUNDNESS: contracts/plan-format.md gives no wire form
   * for the component *instance tree* (`ComponentInstance.parent`), so every
   * instance here is its own root. With no ancestors, the entering set is
   * `{this}` when the caller is a different instance (or the host) and `{}`
   * when the caller is this instance itself.
   *
   * For a **flat** component this is exact. For a **nested** one it is not
   * merely weaker — it admits reentrance the reference forbids. In the
   * reference, entering a child locks the child *and every ancestor it was
   * reached through*, so a callee cannot call back into an enclosing
   * component that is mid-execution. Here the ancestor is never locked, so
   * that call is permitted and a component can observe itself re-entered —
   * precisely the state `may_enter` exists to make unreachable. It is not a
   * missing optimization; it is a hole in the reentrance gate whose size is
   * "however deep the instance tree is".
   *
   * Nothing in the current corpus exercises it (the sync suite is flat and
   * the async suite is blocked earlier), which is why it is recorded rather
   * than worked around: a faithful fix needs the nesting information in the
   * plan, not a guess in the runtime. Recorded as v0.3 contract friction and
   * as the blocker for `test_cross_component_realloc`.
   */
  enteringSet(caller) {
    const mine = this.selfAndAncestors();
    if (caller === null) return mine;
    for (const c of caller.selfAndAncestors()) mine.delete(c);
    return mine;
  }
  /** definitions.py `ComponentInstance.may_enter_from` (line 214). */
  mayEnterFrom(caller) {
    for (const inst of this.enteringSet(caller)) {
      if (!inst.mayEnter) return false;
    }
    return true;
  }
  /** definitions.py `ComponentInstance.enter_from` (line 220). */
  enterFrom(caller) {
    for (const inst of this.enteringSet(caller)) {
      assert_(inst.mayEnter, "enter_from without may_enter");
      inst.mayEnter = false;
    }
  }
  /** definitions.py `ComponentInstance.leave_to` (line 225). */
  leaveTo(caller) {
    for (const inst of this.enteringSet(caller)) {
      assert_(!inst.mayEnter, "leave_to without a matching enter_from");
      inst.mayEnter = true;
    }
  }
  /** Backwards-compatible host-entry helpers (the M0 spelling). */
  enter() {
    this.enterFrom(null);
  }
  leave() {
    this.leaveTo(null);
  }
};
function liftOptionsEqual(a, b) {
  return a.stringEncoding === b.stringEncoding && a.memory === b.memory;
}
var ADMIT_TRACE = (() => {
  try {
    return Deno.env.get("CE_SP_TRACE") === "1";
  } catch {
    return false;
  }
})();
var Task = class {
  ft;
  opts;
  inst;
  onStart;
  onResolve;
  state;
  /** TaskBorrowScope (cabi/context.ts): live borrows lowered into this task. */
  numBorrows;
  implicitThread;
  threads;
  /**
   * True for a task created by a FACT cross-component call
   * (`prepare-call`, see intrinsics/fact_calls.ts).
   *
   * Such a task's `onStart` / `onResolve` carry **flat core values**, not
   * lifted component values: FACT fuses the caller-side lift and callee-side
   * lower into a pair of adapter functions (`[async-start]` / `[async-return]`)
   * that run *in wasm*, so the host only shuttles the core values between
   * them. definitions.py has no analogue because it has no fused adapters —
   * there, `canon_lift` lowers the params and `canon_lower`'s `on_resolve`
   * lifts the results, both in the host. The observable semantics are
   * identical; only which side of the boundary performs the copy differs.
   *
   * `canon_task_return` consults this to decide whether to lift its flat
   * arguments (host-boundary task) or pass them straight through (FACT task).
   */
  factPassthrough;
  /**
   * In-flight FACT sync-call brackets for THIS task
   * (`enter-sync-call`/`exit-sync-call`).
   *
   * MOVED to `Thread` (see `Thread.syncCallStack`). Per-task was already an
   * improvement on per-executor, but it is still not the right unit: a task
   * can own several threads, so one activation's `exit-sync-call` could pop a
   * sibling activation's scope. Tracing big-interleaving showed exactly that
   * -- tasks whose `enter` count exceeded their `exit` count by one, and other
   * tasks taking an `exit` at depth 0, with the `ctx` fallback never firing.
   *
   * The bracket belongs to the ACTIVATION that opened it: FACT emits the
   * matching `enter-sync-call` and `exit-sync-call` from the same wasm
   * activation by construction, so riding the activation identity makes the
   * exit find the same stack the enter used no matter which task the scheduler
   * considers current in between (the 3i bracket-spans-suspension ruling).
   */
  constructor(ft, opts, inst, onStart, onResolve) {
    this.ft = ft;
    this.opts = opts;
    this.inst = inst;
    this.onStart = onStart;
    this.onResolve = onResolve;
    this.state = "initial";
    this.numBorrows = 0;
    this.implicitThread = null;
    this.threads = [];
    this.factPassthrough = false;
  }
  /**
   * definitions.py `Task.needs_exclusive` (line 473): an async-typed task
   * needs the instance's exclusive thread unless it is a *stackful* async
   * lift. Sync-lowered (`not opts.async_`) and callback-ABI tasks both do.
   */
  needsExclusive() {
    assert_(this.ft.async === true, "needs_exclusive on a sync-typed task");
    return !this.opts.async_ || this.opts.callback;
  }
  /**
   * definitions.py `Task.enter_implicit_thread` (line 477) — the backpressure
   * and exclusivity gate, in full.
   *
   * Returns false when the task was cancelled while waiting to enter, in
   * which case the caller must return immediately (the task is already
   * resolved by `cancel()`).
   */
  *enterImplicitThread(thread) {
    assert_(this.state === "initial", "enter_implicit_thread after start");
    this.implicitThread = thread;
    if (this.ft.async === true) {
      const hasBackpressure = () => this.inst.backpressure > 0 || this.needsExclusive() && this.inst.exclusiveThread !== null;
      if (hasBackpressure() || this.inst.numWaitingToEnter > 0) {
        this.inst.numWaitingToEnter += 1;
        let cancelled;
        try {
          cancelled = yield* thread.waitUntil(() => !hasBackpressure(), true);
        } finally {
          this.inst.numWaitingToEnter -= 1;
        }
        if (cancelled) {
          this.cancel();
          return false;
        }
      }
      if (this.needsExclusive()) {
        assert_(this.inst.exclusiveThread === null, "entering with the exclusive thread already taken");
        this.inst.exclusiveThread = thread;
      }
    }
    if (ADMIT_TRACE) {
      console.error(`[admit] task=${dbgId(this)} thread=${dbgId(thread)}`);
    }
    this.registerThread(thread);
    return true;
  }
  /** definitions.py `Task.register_thread` (line 497). */
  registerThread(thread) {
    assert_(!this.threads.includes(thread) && thread.task === this, "register_thread of a foreign or duplicate thread");
    this.threads.push(thread);
    assert_(thread.index === null, "register_thread of an indexed thread");
    thread.index = this.inst.threads.add(thread);
  }
  /** definitions.py `Task.exit_implicit_thread` (line 503). */
  exitImplicitThread(thread) {
    assert_(thread === this.implicitThread, "exit of a non-implicit thread");
    this.unregisterThread(thread);
    if (this.ft.async === true && this.needsExclusive()) {
      assert_(this.inst.exclusiveThread === thread, "exit_implicit_thread without holding the exclusive thread");
      this.inst.exclusiveThread = null;
    }
  }
  /** definitions.py `Task.unregister_thread` (line 510). */
  unregisterThread(thread) {
    const i = this.threads.indexOf(thread);
    assert_(i !== -1 && thread.task === this, "unregister of a foreign thread");
    this.threads.splice(i, 1);
    if (this.threads.length === 0) {
      trapIf(this.state !== "resolved", "task finished all threads without resolving");
      assert_(this.numBorrows === 0, "task exited with live borrows");
    }
    assert_(thread.index !== null, "unregister of an unindexed thread");
    this.inst.threads.remove(thread.index);
    thread.index = null;
  }
  /**
   * definitions.py `Task.request_cancellation` (line 519). Delivered to a
   * cancellable thread if one exists and the instance is enterable; otherwise
   * recorded as pending, to be picked up at the next cancellable block point
   * (`deliverPendingCancel`).
   */
  requestCancellation(caller) {
    if (this.state === "initial") {
      this.state = "cancel-delivered";
      this.implicitThread.resume(CANCELLED_TRUE);
      return;
    }
    assert_(this.state === "started", `request_cancellation in state ${this.state}`);
    let candidates = this.threads.filter((t) => t.cancellable);
    const excludeImplicit = this.ft.async === true && this.needsExclusive() && this.inst.exclusiveThread !== null && this.inst.exclusiveThread !== this.implicitThread;
    if (excludeImplicit) {
      candidates = candidates.filter((t) => t !== this.implicitThread);
    }
    if (!excludeImplicit) {
      const store2 = this.inst.store;
      for (const w of store2.waiting) {
        if (w.task === this && w.cancellable === true && !candidates.includes(w)) {
          candidates.push(w);
        }
      }
    }
    if (candidates.length > 0 && this.inst.mayEnterFrom(caller)) {
      this.state = "cancel-delivered";
      this.inst.enterFrom(caller);
      try {
        chooseCandidate(candidates).resume(CANCELLED_TRUE);
      } finally {
        this.inst.leaveTo(caller);
      }
    } else {
      this.state = "pending-cancel";
    }
  }
  /** definitions.py `Task.deliver_pending_cancel` (line 536). */
  deliverPendingCancel(cancellable) {
    if (cancellable && this.state === "pending-cancel") {
      this.state = "cancel-delivered";
      return true;
    }
    return false;
  }
  /** definitions.py `Task.start` (line 542). */
  start() {
    assert_(this.state === "initial", "start on a started task");
    this.state = "started";
    return this.onStart();
  }
  /** definitions.py `Task.return_` (line 547). */
  return_(result) {
    trapIf(this.state === "resolved", "task.return on a resolved task");
    trapIf(this.numBorrows > 0, "task returned with live borrows");
    this.onResolve(result);
    this.state = "resolved";
  }
  /** definitions.py `Task.cancel` (line 554). */
  cancel() {
    trapIf(this.state !== "cancel-delivered", "task.cancel without a delivered cancellation request");
    trapIf(this.numBorrows > 0, "task cancelled with live borrows");
    this.onResolve(null);
    this.state = "resolved";
  }
};

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/runtime/src/jspi/mechanics.ts
function isSupported() {
  return typeof globalThis.WebAssembly === "object" && typeof WebAssembly.promising === "function" && typeof WebAssembly.Suspending === "function";
}
function assertSupported() {
  if (!isSupported()) {
    throw new Error("JSPI (WebAssembly.promising / WebAssembly.Suspending) is not available in this engine; see docs/architecture.md \xA73 for the compatibility floor (no fallback path exists).");
  }
}
function makePromising(wasmExport) {
  assertSupported();
  return WebAssembly.promising(wasmExport);
}
function makeSuspending(fn) {
  assertSupported();
  return new WebAssembly.Suspending(fn);
}

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/runtime/src/jspi/bridge.ts
function chooseMode(requested, needed) {
  if (requested === false) return "plain";
  const want = requested === true || needed === true;
  return want && isSupported() ? "jspi" : "plain";
}
function trampolineNeedsSuspension(t, optionsAsync) {
  switch (t.kind) {
    case "sync-start-call":
    case "waitable-set-wait":
    case "thread-yield":
      return true;
    case "subtask-cancel":
    case "stream-cancel-read":
    case "stream-cancel-write":
    case "future-cancel-read":
    case "future-cancel-write":
      return t.async !== true;
    case "stream-read":
    case "stream-write":
    case "future-read":
    case "future-write":
      return typeof t.options === "number" ? !optionsAsync(t.options) : true;
    default:
      return false;
  }
}
function trampolineCanBlock(t, optionsAsync) {
  return t.kind === "async-start-call" || t.kind === "subtask-cancel" || trampolineNeedsSuspension(t, optionsAsync);
}
function planNeedsSuspension(plan) {
  for (const o of plan.canonicalOptions) {
    if (o.async && o.callback === null) return true;
  }
  const optionsAsync = (i) => plan.canonicalOptions[i]?.async === true;
  for (const t of plan.trampolines) {
    if (trampolineNeedsSuspension(t, optionsAsync)) return true;
  }
  return false;
}
function enterWasm(fn, mode) {
  if (mode === "plain") return fn;
  assert_(isSupported(), "jspi mode selected on an engine without JSPI");
  return makePromising(fn);
}
function sentinelFor(owner) {
  if (owner === null || owner === void 0) return;
  SENTINEL_TICK.then(() => claimActivationAmbient(owner));
}
var SENTINEL_TICK = Promise.resolve();
function attributeContinuation(owner, r) {
  return Promise.resolve(r).then((v) => {
    sentinelFor(owner);
    return v;
  }, (e) => {
    sentinelFor(owner);
    throw e;
  });
}
function suspendingImport(fn, mode) {
  if (mode === "plain") return fn;
  assert_(isSupported(), "jspi mode selected on an engine without JSPI");
  const claimingFn = (...args) => {
    const owner = maybeCurrentThread() ?? null;
    const invoke = () => fn(...args);
    let r;
    try {
      r = owner === null ? invoke() : withActivation(owner, invoke);
    } catch (e) {
      claimActivationAmbient(owner);
      throw e;
    }
    if (r === null || typeof r?.then !== "function") {
      claimActivationAmbient(owner);
      sentinelFor(owner);
      return r;
    }
    if (SP_TRACE) {
      console.error(`[sp] hop-suspend owner=${dbgId(owner)} promise=${dbgId(r)}`);
    }
    return attributeContinuation(owner, r);
  };
  return makeSuspending(claimingFn);
}
function assertModeConsistent(mode, entriesWrapped, importsWrapped) {
  if (mode === "plain") {
    assert_(!entriesWrapped && !importsWrapped, `plain mode with wrapped entries=${entriesWrapped} / imports=${importsWrapped} \u2014 wrapping ran under the wrong mode`);
    return;
  }
  assert_(entriesWrapped || !importsWrapped, `suspension mode jspi wrapped imports without wrapping any entry (entries=${entriesWrapped}, imports=${importsWrapped}) \u2014 a Suspending import reached from a non-promising activation traps unconditionally (jspi pin (c))`);
}
var SP_TRACE = (() => {
  try {
    return Deno.env.get("CE_SP_TRACE") === "1";
  } catch {
    return false;
  }
})();
var SuspensionPoint = class {
  task;
  readyFunc;
  cancellable;
  produce;
  promise;
  #settle;
  #fail;
  #done;
  #store;
  /**
   * WHO the engine will resume when this point's promise settles.
   *
   * Captured HERE, at construction, and not derived at resume time: the
   * blocking built-in that mints this point is running under the suspending
   * activation's own ambient, so the ambient names that activation exactly.
   * This is the replacement for the async-context store the scheduler
   * used to rely on (M3A-1): same value, obtained by construction instead of
   * by asking the platform to carry a context across the engine's resumption.
   * `task.implicitThread` is the fallback for the one shape that has no
   * ambient at all — a built-in reached during instantiation.
   */
  // deno-lint-ignore no-explicit-any
  owner;
  constructor(store2, task, readyFunc, cancellable, produce, owner) {
    this.task = task;
    this.readyFunc = readyFunc;
    this.cancellable = cancellable;
    this.produce = produce;
    this.#done = false;
    this.#store = store2;
    this.owner = owner ?? maybeCurrentThread() ?? task?.implicitThread ?? null;
    if (SP_TRACE) {
      console.error(`[sp] mint ${dbgId(this)} owner=${dbgId(this.owner)} task=${dbgId(this.task)}
${(new Error().stack ?? "").split("\n").slice(2, 5).join("\n")}`);
    }
    this.promise = new Promise((res, rej) => {
      this.#settle = res;
      this.#fail = rej;
    });
    store2.startWaiting(this);
  }
  waiting() {
    return !this.#done;
  }
  ready() {
    return !this.#done && this.readyFunc !== null && this.readyFunc();
  }
  /** Settle the import's Promise; the engine resumes the wasm activation. */
  resume(cancelled = false) {
    assert_(!this.#done, "resume of an already-resumed suspension point");
    if (SP_TRACE) {
      console.error(`[sp] resume ${dbgId(this)} owner=${dbgId(this.owner)}
${(new Error().stack ?? "").split("\n").slice(2, 5).join("\n")}`);
    }
    this.#done = true;
    this.#store.stopWaiting(this);
    let value;
    try {
      value = this.produce(cancelled);
    } catch (e) {
      if (maybeCurrentThread() === void 0) claimActivationAmbient(this.owner);
      setResumingThread(this.task?.implicitThread ?? null);
      this.#fail(e);
      return;
    }
    consumeClaimIfRunning();
    if (maybeCurrentThread() === void 0) claimActivationAmbient(this.owner);
    setResumingThread(this.task?.implicitThread ?? null);
    this.#settle(value);
  }
  /** Abandon this suspension without resuming the guest (teardown paths). */
  abandon(reason) {
    if (this.#done) return;
    this.#done = true;
    this.#store.stopWaiting(this);
    this.#fail(reason);
  }
};
function blockCurrentActivation(input) {
  const owner = maybeCurrentThread() ?? input.task?.implicitThread ?? null;
  consumeClaimIfRunning();
  releaseActivationAmbient(owner);
  const point = new SuspensionPoint(input.store, input.task, input.readyFunc, input.cancellable, input.produce, owner);
  return point.promise;
}

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/runtime/src/jspi/suspending.ts
var SUSPENDING = Symbol("deltic.suspending-import");
function suspending(fn, context, legacyDescriptor) {
  if (typeof context === "string" || typeof context === "symbol" || legacyDescriptor !== void 0) {
    throw new TypeError("suspending: legacy (experimentalDecorators) method decoration is not supported \u2014 the decorator would receive the prototype, not the method. Compile with stage-3 decorators (the default), or use the call form: `f: suspending(fn)`.");
  }
  if (context !== void 0) {
    const kind = context.kind;
    if (kind !== "method") {
      throw new TypeError(`suspending: cannot decorate a ${String(kind)} \u2014 only methods (instance or static) can be marked suspendable. Constructors are synchronous by contract; for record-literal imports use the call form: \`f: suspending(fn)\`.`);
    }
  }
  if (typeof fn !== "function") {
    throw new TypeError(`suspending: expected a function, got ${typeof fn}`);
  }
  fn[SUSPENDING] = true;
  return fn;
}
function isSuspending(value) {
  return typeof value === "function" && value[SUSPENDING] === true;
}
function anySuspendingImport(imports) {
  if (imports === void 0) return false;
  for (const value of Object.values(imports)) {
    if (isSuspending(value)) return true;
    if (value !== null && typeof value === "object") {
      for (const member of Object.values(value)) {
        if (isSuspending(member)) return true;
      }
    }
  }
  return false;
}

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/runtime/src/exec/boundary.ts
function newStats() {
  return {
    liftedCalls: 0,
    tasksResolved: 0,
    postReturnsRun: 0,
    loweredCalls: 0,
    enterSyncCalls: 0,
    exitSyncCalls: 0,
    callbackInvocations: 0
  };
}
var LiveMemory = class {
  addrType = "i32";
  #provider;
  #label;
  #buffer = null;
  #bytes = new Uint8Array(0);
  #view = new DataView(new ArrayBuffer(0));
  constructor(provider, label2) {
    this.#provider = provider;
    this.#label = label2;
  }
  #memory() {
    const m = this.#provider();
    if (m === void 0) {
      throw new PlanError(`${this.#label} accessed before its extract-memory initializer ran`);
    }
    return m;
  }
  #refresh() {
    const buffer = this.#memory().buffer;
    if (buffer !== this.#buffer) {
      this.#buffer = buffer;
      this.#bytes = new Uint8Array(buffer);
      this.#view = new DataView(buffer);
    }
  }
  get bytes() {
    this.#refresh();
    return this.#bytes;
  }
  get view() {
    this.#refresh();
    return this.#view;
  }
  get length() {
    return this.#memory().buffer.byteLength;
  }
  ptrType() {
    return this.addrType;
  }
  ptrSize() {
    return 4;
  }
};
var _memInstCheck = new LiveMemory(() => void 0, "check");
function require2(resolver, what) {
  if (resolver === null) return null;
  const v = resolver();
  if (v === void 0) {
    throw new PlanError(`${what} accessed before its extract initializer ran`);
  }
  return v;
}
function cabiOptions(opts) {
  return {
    stringEncoding: opts.stringEncoding,
    memory: opts.memory,
    realloc: opts.realloc === null ? null : (o, os, a, n) => {
      const realloc = require2(opts.realloc, "realloc");
      const p = callCore(realloc, [
        o,
        os,
        a,
        n
      ]);
      trapIf(p.length !== 1 || typeof p[0] !== "number", "realloc result");
      return p[0] >>> 0;
    },
    postReturn: null,
    async_: opts.async,
    // Truthiness only: `flattenFunctype` branches on whether a callback
    // exists (async lifts with a callback return a packed i32; stackful ones
    // return nothing). Passing the resolver rather than `null` is what makes
    // the callback-ABI core type come out right.
    callback: opts.callback === null ? null : opts.callback
  };
}
function callCore(fn, args) {
  let raw;
  try {
    raw = fn(...args);
  } catch (e) {
    throw mapCoreException(e);
  }
  if (raw === void 0) return [];
  if (Array.isArray(raw)) return raw;
  return [
    raw
  ];
}
function mapCoreException(e) {
  if (e instanceof WebAssembly.RuntimeError) {
    try {
      trap(`guest trapped: ${e.message}`);
    } catch (t) {
      return t;
    }
  }
  return e;
}
function normalizeCoreValues(values, lanes, what) {
  if (values.length !== lanes.length) {
    throw new AssertionError(`${what}: expected ${lanes.length} core values, got ${values.length}`);
  }
  return values.map((v, i) => {
    switch (lanes[i]) {
      case "i32":
        assert_(typeof v === "number", `${what}[${i}]: i32 lane`);
        return v >>> 0;
      case "i64":
        assert_(typeof v === "bigint", `${what}[${i}]: i64 lane`);
        return BigInt.asUintN(64, v);
      case "f32":
      case "f64":
        assert_(typeof v === "number", `${what}[${i}]: float lane`);
        return v;
    }
  });
}
function resultsToHost(results) {
  if (results.length === 0) return void 0;
  if (results.length === 1) return results[0];
  return results;
}
function isPromiseLike(v) {
  return typeof v === "object" && v !== null && typeof v.then === "function";
}
var DRIVE_TRACE = (() => {
  try {
    return Deno.env.get("DELTIC_DRIVE_TRACE") === "1";
  } catch {
    return false;
  }
})();
var traceTurn = 0;
function describeWaiter(t) {
  const w = t;
  const kind = w?.constructor?.name ?? "?";
  let verdict = "?";
  try {
    verdict = w.ready?.() ? "READY" : w.readyFunc === null ? "explicit" : "not-ready";
  } catch (e) {
    verdict = `threw:${e}`;
  }
  return `${kind}[${verdict}]`;
}
function traceDrive(loop, store2, done, branch) {
  if (!DRIVE_TRACE) return;
  let doneVerdict = "?";
  try {
    doneVerdict = String(done());
  } catch (e) {
    doneVerdict = `threw:${e}`;
  }
  const waiters = store2.waiting.map(describeWaiter).join(",");
  const awaiters = [
    ...store2.awaiting
  ].map((t) => {
    const a = t;
    return `${a?.constructor?.name ?? "?"}`;
  }).join(",");
  console.error(`[drive #${traceTurn++}] ${loop} branch=${branch} ready=${store2.readyCandidates().length} waiting=${store2.waiting.length}{${waiters}} awaiting=${store2.awaiting.size} hostCalls=${store2.pendingHostCalls.size} awaiters={${awaiters}} claim=${hasResumingThread()} done=${doneVerdict}`);
}
function drive(store2, done, what) {
  for (; ; ) {
    traceDrive("drive", store2, done, "top");
    while (store2.awaiting.size === 0 && store2.tick()) {
      traceDrive("drive", store2, done, "ticked");
      if (store2.hostFailure !== void 0) throw takeHostFailure(store2);
    }
    if (store2.hostFailure !== void 0) throw takeHostFailure(store2);
    if (done()) {
      traceDrive("drive", store2, done, "EXIT-done");
      return;
    }
    if (store2.awaiting.size > 0 || hasResumingThread()) {
      traceDrive("drive", store2, done, "->async(awaiting/claim)");
      return driveAsync(store2, done, what);
    }
    if (store2.pendingHostCalls.size === 0) {
      traceDrive("drive", store2, done, "DEADLOCK-TRAP");
      trapIf(true, `wasm trap: deadlock detected: event loop cannot make further progress (${what}: no thread is ready and no host call is outstanding)`);
    }
    traceDrive("drive", store2, done, "->async(hostcalls)");
    return driveAsync(store2, done, what);
  }
}
var taggedAwaits = /* @__PURE__ */ new WeakMap();
function tagAwait(t) {
  const p = t.awaiting;
  let tag = taggedAwaits.get(p);
  if (tag === void 0) {
    tag = p.then((value) => ({
      t,
      p,
      value,
      failure: void 0
    }), (e) => ({
      t,
      p,
      value: void 0,
      failure: {
        error: e
      }
    }));
    taggedAwaits.set(p, tag);
  }
  return tag;
}
async function driveStoreAsync(store2, done, what) {
  return await driveAsync(store2, done, what);
}
var driverDepth = /* @__PURE__ */ new WeakMap();
var driverIdle = /* @__PURE__ */ new WeakMap();
function storeDriverDepth(store2) {
  return driverDepth.get(store2) ?? 0;
}
function whenStoreDriverIdle(store2) {
  if (storeDriverDepth(store2) === 0) return Promise.resolve();
  let w = driverIdle.get(store2);
  if (w === void 0) {
    let r;
    const p = new Promise((res) => r = res);
    w = {
      p,
      r
    };
    driverIdle.set(store2, w);
  }
  return w.p;
}
async function driveAsync(store2, done, what) {
  driverDepth.set(store2, storeDriverDepth(store2) + 1);
  try {
    let claimHops = 0;
    for (; ; ) {
      traceDrive("driveAsync", store2, done, "top");
      store2.serviceSettled();
      if (store2.hostFailure !== void 0) throw takeHostFailure(store2);
      if (hasResumingThread()) {
        traceDrive("driveAsync", store2, done, "yield-claim");
        claimHops++;
        assert_(claimHops < 1e4, "driveAsync: a resumed-activation claim was never released (the activation neither parked, finished, nor trapped)");
        if (claimHops % 100 === 0) {
          await new Promise((r) => setTimeout(r, 0));
        } else {
          await Promise.resolve();
        }
        continue;
      }
      claimHops = 0;
      while (store2.tick()) {
        if (store2.hostFailure !== void 0) throw takeHostFailure(store2);
        if (store2.awaiting.size > 0) {
          await Promise.resolve();
          if (store2.settled.length > 0) break;
        }
      }
      if (store2.hostFailure !== void 0) throw takeHostFailure(store2);
      if (done()) {
        traceDrive("driveAsync", store2, done, "EXIT-done");
        return;
      }
      if (store2.settled.length > 0 || hasResumingThread()) {
        continue;
      }
      if (store2.awaiting.size > 0) {
        if (store2.pendingHostCalls.size === 0 && !hasResumingThread()) {
          traceDrive("driveAsync", store2, done, "deadlock-probe");
          const parked2 = [
            ...store2.awaiting
          ];
          const progressed = await Promise.race([
            ...parked2.map((t) => tagAwait(t).then(() => true)),
            new Promise((r) => setTimeout(() => r(false), 0))
          ]);
          traceDrive("driveAsync", store2, done, `deadlock-probe:progressed=${progressed}`);
          if (!progressed) {
            const fresh = [
              ...store2.awaiting
            ];
            const changed = fresh.length !== parked2.length || fresh.some((t, i) => t !== parked2[i]);
            if (changed) continue;
            if (store2.readyCandidates().length === 0) {
              trapIf(true, `wasm trap: deadlock detected: event loop cannot make further progress (${what}: every suspended activation is waiting on a suspension only this scheduler could resume, and none is ready)`);
            }
            continue;
          }
        }
        if (store2.awaiting.size === 0) continue;
        const parked = [
          ...store2.awaiting
        ];
        const chosen = parked[0];
        const chosenTag = tagAwait(chosen);
        const others = parked.slice(1).map(tagAwait);
        for (const h of store2.pendingHostCalls) {
          others.push(h.then(() => null, () => null));
        }
        setResumingThread(chosen);
        let winner;
        try {
          winner = await Promise.race([
            chosenTag,
            ...others
          ]);
        } finally {
          clearResumingThread();
        }
        if (winner !== null && store2.awaiting.has(winner.t) && winner.t.awaiting === winner.p) {
          winner.t.resumeWith(winner.value, winner.failure);
        }
        continue;
      }
      if (store2.pendingHostCalls.size === 0) {
        traceDrive("driveAsync", store2, done, "DEADLOCK-TRAP");
        trapIf(true, `wasm trap: deadlock detected: event loop cannot make further progress (${what}: no thread is ready and no host call is outstanding)`);
      }
      traceDrive("driveAsync", store2, done, "await-race");
      await Promise.race([
        ...store2.pendingHostCalls
      ]).catch(() => {
      });
    }
  } finally {
    const left = storeDriverDepth(store2) - 1;
    driverDepth.set(store2, left);
    if (left === 0) {
      const w = driverIdle.get(store2);
      driverIdle.delete(store2);
      w?.r();
    }
  }
}
function takeHostFailure(store2) {
  const e = store2.hostFailure;
  store2.hostFailure = void 0;
  return e;
}
var CONSTRUCTOR_SYNC_ENTRY = Symbol("deltic.constructorSyncEntry");
function createLiftedFunction(input) {
  const { name, ft, opts, core, stats: stats2, trapState, syncCallStack, allInstances } = input;
  const inst = opts.instance;
  const store2 = inst.store;
  const mode = input.suspensionMode ?? "plain";
  const enteredCore = enterWasm(core, mode);
  const taskOpts = {
    async_: opts.async,
    callback: opts.callback !== null,
    stringEncoding: opts.stringEncoding,
    memory: opts.memory
  };
  if (opts.callback !== null && !opts.async) {
    throw new PlanError(`export '${name}': canonical options carry a callback but are not async (callback is meaningless for a sync lift)`);
  }
  const computed = flattenFunctype(cabiOptions(opts), ft, "lift");
  if (!coreFuncTypeEquals(computed, opts.coreType)) {
    throw new PlanError(`export '${name}': computed flat type ${JSON.stringify(computed)} != plan coreType ${JSON.stringify(opts.coreType)}`);
  }
  return (...hostArgs) => {
    if (hostArgs.length !== ft.params.length) {
      throw new TypeError(`${name}: expected ${ft.params.length} argument(s), got ${hostArgs.length}`);
    }
    stats2.liftedCalls++;
    if (trapState !== void 0) trapState.pending = void 0;
    const syncCallDepth = syncCallStack?.length ?? 0;
    trapIf(!inst.mayEnterFrom(null), `cannot enter component instance ${inst.index} (reentrance forbidden)`);
    const enteredSet = inst.enteringSet(null);
    inst.enterFrom(null);
    let entered = true;
    let completed = false;
    let resolved = null;
    let resolvedSeen = false;
    const task = new Task(ft, taskOpts, inst, () => hostArgs, (result) => {
      resolved = result;
      resolvedSeen = true;
      stats2.tasksResolved++;
    });
    const thread = new Thread(task, liftBody({
      name,
      ft,
      opts,
      core: enteredCore,
      stats: stats2,
      task,
      thread: () => thread,
      mode
    }));
    const finishHostEntry = () => {
      completed = true;
      trapIf(!resolvedSeen, `${name}: task finished without resolving (deadlock)`);
      if (resolved === null) {
        throw new AssertionError(`${name}: task resolved as cancelled, but the host never requested cancellation`);
      }
      return resultsToHost(resolved);
    };
    const unwind = () => {
      if (completed) return;
      for (const t of task.threads) {
        while (t.syncCallStack.length > 0) {
          t.syncCallStack.pop().releaseLenders();
        }
      }
      void syncCallStack;
      void syncCallDepth;
      for (const i of allInstances?.() ?? []) {
        if (!enteredSet.has(i)) {
          i.mayLeave = true;
        }
      }
    };
    const leave = () => {
      if (!entered) return;
      entered = false;
      inst.leaveTo(null);
    };
    const poison = () => {
      entered = false;
    };
    const isCapabilitySignal = (e) => e instanceof NeedsJspi || e instanceof PendingCapability;
    try {
      thread.resume();
      if (!ft.async && mode !== "jspi") driveSyncLift(task);
    } catch (e) {
      unwind();
      if (isCapabilitySignal(e)) leave();
      else poison();
      throw e;
    }
    leave();
    let pending;
    try {
      const midWasmCall = () => task.threads.some((t) => store2.awaiting.has(t));
      pending = drive(store2, () => resolvedSeen && !midWasmCall(), `export '${name}'`);
    } catch (e) {
      unwind();
      throw e;
    }
    if (pending === void 0) {
      try {
        return finishHostEntry();
      } catch (e) {
        unwind();
        throw e;
      }
    }
    return pending.then(finishHostEntry, (e) => {
      unwind();
      throw e;
    });
  };
}
function* awaitCore(fn, args, thread) {
  const raw = withActivation(thread, () => callCore(fn, args));
  if (raw.length === 1 && isPromiseLike(raw[0])) {
    const settled = yield {
      readyFunc: null,
      cancellable: false,
      // A rejection of the promising Promise is a core trap by another route
      // (jspi pin (e)); translate it exactly as `callCore` translates a
      // synchronous throw, so the embedder sees one `Trap` vocabulary in both
      // modes (see `mapCoreException`).
      awaitValue: Promise.resolve(raw[0]).then(void 0, (e) => {
        throw mapCoreException(e);
      })
    };
    if (settled === void 0) return [];
    return Array.isArray(settled) ? settled : [
      settled
    ];
  }
  return raw;
}
var CallbackCode = /* @__PURE__ */ function(CallbackCode2) {
  CallbackCode2[CallbackCode2["EXIT"] = 0] = "EXIT";
  CallbackCode2[CallbackCode2["YIELD"] = 1] = "YIELD";
  CallbackCode2[CallbackCode2["WAIT"] = 2] = "WAIT";
  return CallbackCode2;
}(CallbackCode || {});
var CALLBACK_CODE_MAX = 2;
function unpackCallbackResult(packed) {
  const code = packed & 15;
  trapIf(code > CALLBACK_CODE_MAX, `invalid callback code ${code}`);
  return [
    code,
    packed >>> 4
  ];
}
function* liftBody(input) {
  const { name, ft, opts, core, stats: stats2, task } = input;
  const thread = input.thread();
  const inst = opts.instance;
  if (!(yield* task.enterImplicitThread(thread))) return;
  const cx = new LiftLowerContext(cabiOptions(opts), inst, task);
  const args = task.start();
  const flatArgs = lowerFlatValues(cx, MAX_FLAT_PARAMS, args, ft.params);
  if (!opts.async) {
    const flatResults = normalizeCoreValues(yield* awaitCore(core, flatArgs, thread), opts.coreType.results, `${name} results`);
    const results = liftFlatValues(cx, MAX_FLAT_RESULTS, new CoreValueIter(flatResults), ft.results);
    task.return_(results);
    const postReturn = require2(opts.postReturn, `${name} post-return`);
    if (postReturn !== null) {
      assert_(inst.mayLeave, "post-return with may_leave already false");
      inst.mayLeave = false;
      callCore(postReturn, flatResults);
      inst.mayLeave = true;
      stats2.postReturnsRun++;
    }
    task.exitImplicitThread(thread);
    return;
  }
  if (opts.callback === null) {
    if (input.mode !== "jspi") {
      needsJspi(`stackful async lift of export '${name}' (async canonical options without a callback)`);
    }
    yield* awaitCore(core, flatArgs, thread);
    task.exitImplicitThread(thread);
    return;
  }
  const callback = enterWasm(require2(opts.callback, `${name} callback`), input.mode);
  const [packed] = normalizeCoreValues(yield* awaitCore(core, flatArgs, thread), opts.coreType.results, `${name} results`);
  yield* runCallbackLoop({
    name,
    task,
    thread,
    inst,
    callback,
    packed,
    stats: stats2
  });
  task.exitImplicitThread(thread);
}
function createLoweredImport(input) {
  const { name, ft, opts, hostFn, stats: stats2, mode, suspendable } = input;
  const inst = opts.instance;
  const store2 = inst.store;
  const computed = flattenFunctype(cabiOptions(opts), ft, "lower");
  if (!coreFuncTypeEquals(computed, opts.coreType)) {
    throw new PlanError(`import '${name}': computed flat type ${JSON.stringify(computed)} != plan coreType ${JSON.stringify(opts.coreType)}`);
  }
  const maxFlatParams = opts.async ? MAX_FLAT_ASYNC_PARAMS : MAX_FLAT_PARAMS;
  const maxFlatResults = opts.async ? 0 : MAX_FLAT_RESULTS;
  return (...rawFlatArgs) => {
    stats2.loweredCalls++;
    trapIf(!inst.mayLeave, `cannot leave component instance ${inst.index} (may_leave violation)`);
    const subtask = new Subtask();
    const cx = new LiftLowerContext(cabiOptions(opts), inst, subtask);
    const vi = new CoreValueIter(normalizeCoreValues(rawFlatArgs, opts.coreType.params, `${name} args`));
    let onProgress2 = () => {
    };
    const onStart = () => {
      onProgress2();
      assert_(subtask.state === SubtaskState.STARTING, `${name}: on_start on a started subtask`);
      subtask.state = SubtaskState.STARTED;
      return liftFlatValues(cx, maxFlatParams, vi, ft.params);
    };
    const onResolve = (result) => {
      onProgress2();
      if (result === null) {
        assert_(subtask.cancellationRequested, `${name}: resolved as cancelled without a cancellation request`);
        subtask.resolve(subtask.state === SubtaskState.STARTING ? SubtaskState.CANCELLED_BEFORE_STARTED : SubtaskState.CANCELLED_BEFORE_RETURNED, []);
        return;
      }
      assert_(subtask.state === SubtaskState.STARTED, `${name}: on_resolve on a subtask that never started`);
      const flatResults = lowerFlatValues(cx, maxFlatResults, result, ft.results, vi);
      subtask.resolve(SubtaskState.RETURNED, flatResults);
    };
    subtask.onCancel = () => {
    };
    const args = onStart();
    const raw = hostFn(...args);
    const toResults = (v) => ft.results.length === 0 ? [] : [
      v
    ];
    if (isPromiseLike(raw)) {
      if (!opts.async) {
        if (mode !== "jspi" || !suspendable) {
          needsJspi(suspendable ? `synchronous lower of import '${name}', whose host implementation returned a Promise (the guest's wasm frame must block)` : `synchronous lower of import '${name}', whose host implementation returned a Promise; a sync-typed import may only park the frame when declared with suspending() (contracts/embedder-api.md \xA7"Functions and async")`);
        }
        let outcome;
        const promise2 = Promise.resolve(raw).then((v) => {
          store2.pendingHostCalls.delete(promise2);
          outcome = {
            value: v
          };
        }, (e) => {
          store2.pendingHostCalls.delete(promise2);
          outcome = {
            error: e
          };
        });
        store2.pendingHostCalls.add(promise2);
        return blockCurrentActivation({
          store: store2,
          task: currentTask(),
          readyFunc: () => outcome !== void 0,
          cancellable: false,
          produce: () => {
            const done = outcome;
            if ("error" in done) {
              throw done.error;
            }
            onResolve(toResults(done.value));
            subtask.deliverResolve();
            assert_(vi.done(), `${name}: unconsumed flat arguments`);
            const flatResults = subtask.flatResults;
            if (flatResults.length === 0) return void 0;
            if (flatResults.length === 1) return flatResults[0];
            return flatResults;
          }
        });
      }
      const promise = Promise.resolve(raw).then((v) => {
        store2.pendingHostCalls.delete(promise);
        try {
          onResolve(toResults(v));
        } catch (e) {
          store2.hostFailure = e;
        }
      }, (e) => {
        store2.pendingHostCalls.delete(promise);
        store2.hostFailure = e;
      });
      store2.pendingHostCalls.add(promise);
    } else {
      onResolve(toResults(raw));
    }
    assert_(ft.async || subtask.resolved(), `${name}: a non-async-typed import must resolve before returning`);
    if (!opts.async) {
      if (!subtask.resolved()) {
        needsJspi(`synchronous lower of import '${name}' on an unresolved subtask`);
      }
      subtask.deliverResolve();
      assert_(vi.done(), `${name}: unconsumed flat arguments`);
      const flatResults = subtask.flatResults;
      if (flatResults.length === 0) return void 0;
      if (flatResults.length === 1) return flatResults[0];
      return flatResults;
    }
    if (subtask.resolved()) {
      subtask.deliverResolve();
      assert_(subtask.flatResults.length === 0, `${name}: async lower produced flat results`);
      return SubtaskState.RETURNED;
    }
    const subtaski = inst.handles.add(subtask);
    onProgress2 = () => subtask.setSubtaskPendingEvent(subtaski);
    return packSubtaskResult(subtask.state, subtaski);
  };
}
function* runCallbackLoop(input) {
  const { name, task, thread, inst, callback, stats: stats2 } = input;
  let [code, si] = unpackCallbackResult(input.packed);
  while (code !== CallbackCode.EXIT) {
    assert_(task.needsExclusive() && inst.exclusiveThread === task.implicitThread, "callback loop without holding the exclusive thread");
    inst.exclusiveThread = null;
    let event;
    switch (code) {
      case CallbackCode.YIELD: {
        const cancelled = yield* thread.waitUntil(() => inst.exclusiveThread === null, true);
        event = cancelled ? [
          EventCode.TASK_CANCELLED,
          0,
          0
        ] : [
          EventCode.NONE,
          0,
          0
        ];
        break;
      }
      case CallbackCode.WAIT: {
        const wset = inst.handles.get(si);
        trapIf(!(wset instanceof WaitableSet), `callback returned WAIT with index ${si}, which is not a waitable set`);
        event = yield* wset.waitForEventAnd(thread, () => inst.exclusiveThread === null, true);
        break;
      }
      default:
        trap(`invalid callback code ${code}`);
    }
    assert_(inst.exclusiveThread === null, "exclusive thread taken while this task was waiting");
    inst.exclusiveThread = task.implicitThread;
    stats2.callbackInvocations++;
    const [next] = normalizeCoreValues(yield* awaitCore(callback, [
      event[0],
      event[1],
      event[2]
    ], thread), [
      "i32"
    ], `${name} callback result`);
    [code, si] = unpackCallbackResult(next);
  }
}

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/runtime/src/intrinsics/errors.ts
var UnsupportedFeatureError = class extends Error {
  milestone;
  constructor(milestone, what) {
    super(`${what} \u2014 scheduled for ${milestone}, not implemented in the current executor (contracts/intrinsics.md \xA7B)`), this.milestone = milestone;
    this.name = "UnsupportedFeatureError";
  }
};

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/runtime/src/intrinsics/stream_builtins.ts
var COPY_TRACE = (() => {
  try {
    return Deno.env.get("CE_COPY_TRACE") === "1";
  } catch {
    return false;
  }
})();
function traceCopy(msg) {
  if (COPY_TRACE) console.error(`[copy] ${msg}`);
}
function createStreamNew(decl, ctx2, inst) {
  return () => {
    trapIf(!inst.mayLeave, "stream.new: cannot leave component instance");
    const shared = new SharedStreamImpl(ctx2.streamElem(decl.streamTable));
    const ri = inst.handles.add(new ReadableStreamEnd(shared));
    const wi = inst.handles.add(new WritableStreamEnd(shared));
    return packEnds(ri, wi);
  };
}
function createFutureNew(decl, ctx2, inst) {
  return () => {
    trapIf(!inst.mayLeave, "future.new: cannot leave component instance");
    const shared = new SharedFutureImpl(ctx2.futureElem(decl.futureTable));
    const ri = inst.handles.add(new ReadableFutureEnd(shared));
    const wi = inst.handles.add(new WritableFutureEnd(shared));
    return packEnds(ri, wi);
  };
}
function packEnds(ri, wi) {
  return BigInt(ri >>> 0) | BigInt(wi >>> 0) << 32n;
}
function streamCopy(input) {
  const { EndT, reading, eventCode, elem, opts, inst, i, ptr, n } = input;
  const mode = input.mode ?? "plain";
  trapIf(!inst.mayLeave, "stream copy: cannot leave component instance");
  const e = inst.handles.get(i);
  trapIf(!(e instanceof EndT), "stream copy: wrong end type for this handle");
  const end = e;
  trapIf(!sameElemType(end.shared.t, elem), "stream copy: element type mismatch");
  trapIf(end.state === CopyState.DONE, reading ? "cannot read from stream after being notified that the writable end dropped" : "cannot write to stream after being notified that the readable end dropped");
  trapIf(end.state !== CopyState.IDLE, "cannot have concurrent operations active on a future/stream");
  trapIf(end.inWaitableSet() && !opts.async, "synchronous stream copy on an end that is in a waitable set");
  const cx = new LiftLowerContext(cabiOptions(opts), inst, null);
  const buffer = new GuestBuffer(elem, cx, ptr, n);
  const streamEvent = (result, reclaim) => {
    reclaim();
    assert_(end.copying(), "stream event on a non-copying end");
    end.state = result === CopyResult.DROPPED ? CopyState.DONE : CopyState.IDLE;
    assert_(buffer.progress <= BUFFER_MAX_LENGTH, "stream progress out of packing range");
    return [
      eventCode,
      i,
      (result | buffer.progress << 4) >>> 0
    ];
  };
  end.state = CopyState.COPYING;
  const onCopy = (reclaim) => end.setPendingEvent(() => streamEvent(CopyResult.COMPLETED, reclaim));
  const onCopyDone = (result) => end.setPendingEvent(() => streamEvent(result, () => {
  }));
  if (reading) {
    end.copy(inst, buffer, onCopy, onCopyDone);
  } else {
    end.copy(inst, buffer, onCopy, onCopyDone);
  }
  return finishCopy(end, eventCode, i, opts.async, "stream", inst, mode);
}
function futureCopy(input) {
  const { EndT, reading, eventCode, elem, opts, inst, i, ptr } = input;
  const mode = input.mode ?? "plain";
  trapIf(!inst.mayLeave, "future copy: cannot leave component instance");
  const e = inst.handles.get(i);
  trapIf(!(e instanceof EndT), "future copy: wrong end type for this handle");
  const end = e;
  trapIf(!sameElemType(end.shared.t, elem), "future copy: element type mismatch");
  trapIf(end.state === CopyState.DONE, reading ? "cannot read from future after previous read succeeded" : "cannot write to future after previous write succeeded or readable end dropped");
  trapIf(end.state !== CopyState.IDLE, "cannot have concurrent operations active on a future/stream");
  trapIf(end.inWaitableSet() && !opts.async, "synchronous future copy on an end that is in a waitable set");
  const cx = new LiftLowerContext(cabiOptions(opts), inst, null);
  const buffer = new GuestBuffer(elem, cx, ptr, 1);
  const futureEvent = (result) => {
    assert_(buffer.remain() === 0 === (result === CopyResult.COMPLETED), "future event/progress disagreement");
    assert_(end.copying(), "future event on a non-copying end");
    end.state = result === CopyResult.DROPPED || result === CopyResult.COMPLETED ? CopyState.DONE : CopyState.IDLE;
    return [
      eventCode,
      i,
      result
    ];
  };
  end.state = CopyState.COPYING;
  const onCopyDone = (result) => {
    assert_(result !== CopyResult.DROPPED || eventCode === EventCode.FUTURE_WRITE, "a readable future end cannot observe DROPPED");
    end.setPendingEvent(() => futureEvent(result));
  };
  if (reading) {
    end.copy(inst, buffer, onCopyDone);
  } else {
    end.copy(inst, buffer, onCopyDone);
  }
  return finishCopy(end, eventCode, i, opts.async, "future", inst, mode);
}
function finishCopy(end, eventCode, i, async_, what, inst, mode = "plain") {
  const take = () => {
    const [code, index, payload] = end.getPendingEvent();
    assert_(code === eventCode && index === i, `unexpected event delivered by a ${what} copy`);
    return payload;
  };
  if (!end.hasPendingEvent()) {
    if (!async_) {
      if (mode === "jspi" && inst !== void 0) {
        end.hasSyncWaiter = true;
        traceCopy(`${what} sync copy i=${i} BLOCKS`);
        return blockCurrentActivation({
          store: inst.store,
          task: currentTask(),
          readyFunc: () => end.hasPendingEvent(),
          cancellable: false,
          produce: () => {
            end.hasSyncWaiter = false;
            const p2 = take();
            traceCopy(`${what} sync copy i=${i} RESUME -> 0x${p2.toString(16)}`);
            return p2;
          }
        });
      }
      needsJspi(`synchronous ${what} copy with no counterpart ready (the calling wasm frame must block until the other end arrives)`);
    }
    traceCopy(`${what} async copy i=${i} -> BLOCKED`);
    return BLOCKED;
  }
  const p = take();
  traceCopy(`${what} copy(async=${async_}) i=${i} -> 0x${p.toString(16)}`);
  return p;
}
function takeCancelEvent(end, eventCode, i, what) {
  const [code, index, payload] = end.getPendingEvent();
  assert_(!end.copying() && code === eventCode && index === i, `unexpected event delivered by ${what}`);
  const isStreamEvent = eventCode === EventCode.STREAM_READ || eventCode === EventCode.STREAM_WRITE;
  if (isStreamEvent && (payload & 15) === CopyResult.COMPLETED) {
    const p = (payload & ~15 | CopyResult.CANCELLED) >>> 0;
    traceCopy(`${what} i=${i} -> 0x${p.toString(16)} (superseded COMPLETED)`);
    return p;
  }
  traceCopy(`${what} i=${i} -> 0x${payload.toString(16)}`);
  return payload;
}
function cancelCopy(input) {
  const { EndT, eventCode, elem, inst, async_, i, what } = input;
  const mode = input.mode ?? "plain";
  trapIf(!inst.mayLeave, `${what}: cannot leave component instance`);
  const e = inst.handles.get(i);
  trapIf(!(e instanceof EndT), `${what}: wrong end type for this handle`);
  const end = e;
  trapIf(!sameElemType(end.shared.t, elem), `${what}: element type mismatch`);
  trapIf(end.state !== CopyState.COPYING || end.hasSyncWaiter, `${what}: end is not in a cancellable copy`);
  trapIf(end.inWaitableSet() && !async_, `${what}: synchronous cancel on an end that is in a waitable set`);
  end.state = CopyState.CANCELLING_COPY;
  if (!end.hasPendingEvent()) {
    end.shared.cancel();
    if (!end.hasPendingEvent()) {
      if (!async_) {
        if (mode === "jspi") {
          return blockCurrentActivation({
            store: inst.store,
            task: currentTask(),
            readyFunc: () => end.hasPendingEvent(),
            cancellable: false,
            produce: () => takeCancelEvent(end, eventCode, i, what)
          });
        }
        needsJspi(`synchronous ${what} whose copy did not settle immediately (the calling wasm frame must block)`);
      }
      return BLOCKED;
    }
  }
  return takeCancelEvent(end, eventCode, i, what);
}
function dropEnd(EndT, elem, inst, hi, what) {
  trapIf(!inst.mayLeave, `${what}: cannot leave component instance`);
  const e = inst.handles.remove(hi);
  trapIf(!(e instanceof EndT), `${what}: wrong end type for this handle`);
  const end = e;
  trapIf(!sameElemType(end.shared.t, elem), `${what}: element type mismatch`);
  end.drop();
}
function createErrorContextNew(decl, ctx2, inst) {
  const opts = ctx2.options(decl.options);
  return (ptr, taggedCodeUnits) => {
    trapIf(!inst.mayLeave, "error-context.new: cannot leave component instance");
    const cx = new LiftLowerContext(cabiOptions(opts), inst, null);
    const s = loadStringFromRange(cx, ptr ?? 0, taggedCodeUnits ?? 0);
    return inst.handles.add(new ErrorContext(s));
  };
}
function createErrorContextDebugMessage(decl, ctx2, inst) {
  const opts = ctx2.options(decl.options);
  return (i, ptr) => {
    trapIf(!inst.mayLeave, "error-context.debug-message: cannot leave component instance");
    const e = inst.handles.get(i ?? 0);
    trapIf(!(e instanceof ErrorContext), "error-context.debug-message: handle is not an error-context");
    const cx = new LiftLowerContext(cabiOptions(opts), inst, null);
    storeString(cx, e.debugMessage, ptr ?? 0);
  };
}
function createErrorContextDrop(inst) {
  return (i) => {
    trapIf(!inst.mayLeave, "error-context.drop: cannot leave component instance");
    const e = inst.handles.remove(i ?? 0);
    trapIf(!(e instanceof ErrorContext), "error-context.drop: handle is not an error-context");
  };
}
function createStreamRead(d, ctx2, inst) {
  const opts = ctx2.options(d.options);
  const elem = ctx2.streamElem(d.streamTable);
  return (i, ptr, n) => streamCopy({
    mode: ctx2.suspensionMode ?? "plain",
    EndT: ReadableStreamEnd,
    reading: true,
    eventCode: EventCode.STREAM_READ,
    elem,
    opts,
    inst,
    i: i ?? 0,
    ptr: ptr ?? 0,
    n: n ?? 0
  });
}
function createStreamWrite(d, ctx2, inst) {
  const opts = ctx2.options(d.options);
  const elem = ctx2.streamElem(d.streamTable);
  return (i, ptr, n) => streamCopy({
    mode: ctx2.suspensionMode ?? "plain",
    EndT: WritableStreamEnd,
    reading: false,
    eventCode: EventCode.STREAM_WRITE,
    elem,
    opts,
    inst,
    i: i ?? 0,
    ptr: ptr ?? 0,
    n: n ?? 0
  });
}
function createFutureRead(d, ctx2, inst) {
  const opts = ctx2.options(d.options);
  const elem = ctx2.futureElem(d.futureTable);
  return (i, ptr) => futureCopy({
    mode: ctx2.suspensionMode ?? "plain",
    EndT: ReadableFutureEnd,
    reading: true,
    eventCode: EventCode.FUTURE_READ,
    elem,
    opts,
    inst,
    i: i ?? 0,
    ptr: ptr ?? 0
  });
}
function createFutureWrite(d, ctx2, inst) {
  const opts = ctx2.options(d.options);
  const elem = ctx2.futureElem(d.futureTable);
  return (i, ptr) => futureCopy({
    mode: ctx2.suspensionMode ?? "plain",
    EndT: WritableFutureEnd,
    reading: false,
    eventCode: EventCode.FUTURE_WRITE,
    elem,
    opts,
    inst,
    i: i ?? 0,
    ptr: ptr ?? 0
  });
}
function createStreamCancelRead(d, ctx2, inst) {
  const elem = ctx2.streamElem(d.streamTable);
  return (i) => cancelCopy({
    mode: ctx2.suspensionMode ?? "plain",
    EndT: ReadableStreamEnd,
    eventCode: EventCode.STREAM_READ,
    elem,
    inst,
    async_: d.async === true,
    i: i ?? 0,
    what: "stream.cancel-read"
  });
}
function createStreamCancelWrite(d, ctx2, inst) {
  const elem = ctx2.streamElem(d.streamTable);
  return (i) => cancelCopy({
    mode: ctx2.suspensionMode ?? "plain",
    EndT: WritableStreamEnd,
    eventCode: EventCode.STREAM_WRITE,
    elem,
    inst,
    async_: d.async === true,
    i: i ?? 0,
    what: "stream.cancel-write"
  });
}
function createFutureCancelRead(d, ctx2, inst) {
  const elem = ctx2.futureElem(d.futureTable);
  return (i) => cancelCopy({
    mode: ctx2.suspensionMode ?? "plain",
    EndT: ReadableFutureEnd,
    eventCode: EventCode.FUTURE_READ,
    elem,
    inst,
    async_: d.async === true,
    i: i ?? 0,
    what: "future.cancel-read"
  });
}
function createFutureCancelWrite(d, ctx2, inst) {
  const elem = ctx2.futureElem(d.futureTable);
  return (i) => cancelCopy({
    mode: ctx2.suspensionMode ?? "plain",
    EndT: WritableFutureEnd,
    eventCode: EventCode.FUTURE_WRITE,
    elem,
    inst,
    async_: d.async === true,
    i: i ?? 0,
    what: "future.cancel-write"
  });
}
function createStreamDropReadable(d, ctx2, inst) {
  const elem = ctx2.streamElem(d.streamTable);
  return (i) => dropEnd(ReadableStreamEnd, elem, inst, i ?? 0, "stream.drop-readable");
}
function createStreamDropWritable(d, ctx2, inst) {
  const elem = ctx2.streamElem(d.streamTable);
  return (i) => dropEnd(WritableStreamEnd, elem, inst, i ?? 0, "stream.drop-writable");
}
function createFutureDropReadable(d, ctx2, inst) {
  const elem = ctx2.futureElem(d.futureTable);
  return (i) => dropEnd(ReadableFutureEnd, elem, inst, i ?? 0, "future.drop-readable");
}
function createFutureDropWritable(d, ctx2, inst) {
  const elem = ctx2.futureElem(d.futureTable);
  return (i) => dropEnd(WritableFutureEnd, elem, inst, i ?? 0, "future.drop-writable");
}
function transferAsyncEnd(input) {
  const { EndT, srcInst, dstInst, srcElem, dstElem, srcIdx, what } = input;
  const e = srcInst.handles.remove(srcIdx);
  trapIf(!(e instanceof EndT), `${what}: handle is not a readable ${what} end`);
  const end = e;
  trapIf(!sameElemType(end.shared.t, srcElem), `${what}: source element mismatch`);
  trapIf(!sameElemType(end.shared.t, dstElem), `${what}: destination element mismatch`);
  trapIf(end.state === CopyState.DONE, what === "future" ? "cannot lift future after previous read succeeded" : "cannot lift stream after being notified that the writable end dropped");
  trapIf(end.state !== CopyState.IDLE, `cannot remove busy ${what}`);
  trapIf(end.inWaitableSet(), `cannot lift ${what} while it's in a waitable set`);
  const Ctor = EndT;
  return dstInst.handles.add(new Ctor(end.shared));
}
function createStreamTransfer(ctx2) {
  return (srcIdx, srcTable, dstTable) => transferAsyncEnd({
    EndT: ReadableStreamEnd,
    srcInst: ctx2.streamTableInstance(srcTable ?? 0),
    dstInst: ctx2.streamTableInstance(dstTable ?? 0),
    srcElem: ctx2.streamElem(srcTable ?? 0),
    dstElem: ctx2.streamElem(dstTable ?? 0),
    srcIdx: srcIdx ?? 0,
    what: "stream"
  });
}
function createFutureTransfer(ctx2) {
  return (srcIdx, srcTable, dstTable) => transferAsyncEnd({
    EndT: ReadableFutureEnd,
    srcInst: ctx2.futureTableInstance(srcTable ?? 0),
    dstInst: ctx2.futureTableInstance(dstTable ?? 0),
    srcElem: ctx2.futureElem(srcTable ?? 0),
    dstElem: ctx2.futureElem(dstTable ?? 0),
    srcIdx: srcIdx ?? 0,
    what: "future"
  });
}
function createErrorContextTransfer(ctx2, instanceOf) {
  void ctx2;
  return (srcIdx, srcTable, dstTable) => {
    const srcInst = instanceOf(srcTable ?? 0);
    const dstInst = instanceOf(dstTable ?? 0);
    const e = srcInst.handles.get(srcIdx ?? 0);
    trapIf(!(e instanceof ErrorContext), "error-context transfer: handle is not an error-context");
    return dstInst.handles.add(e);
  };
}

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/runtime/src/intrinsics/async_builtins.ts
var BLOCKED = 4294967295;
function createTaskReturn(decl, ctx2) {
  const opts = ctx2.options(decl.options);
  const resultTypes = ctx2.resultTypes(decl.results);
  return (...flatArgs) => {
    const task = currentTask();
    trapIf(!task.inst.mayLeave, "task.return: cannot leave component instance (may_leave violation)");
    trapIf(!task.opts.async_, "task.return from a non-async task");
    trapIf(!task.factPassthrough && !valTypesEqual(resultTypes, task.ft.results), "task.return with a result type that is not the task's result type");
    trapIf(!liftOptionsEqual({
      stringEncoding: opts.stringEncoding,
      memory: opts.memory
    }, task.factPassthrough ? {
      stringEncoding: task.opts.stringEncoding,
      memory: opts.memory
    } : task.opts), "task.return with canonical options differing from the task's");
    const flat = normalizeCoreValues(flatArgs, opts.coreType.params, "task.return arguments");
    if (task.factPassthrough) {
      task.return_(flat);
      return;
    }
    const cx = new LiftLowerContext(cabiOptions(opts), task.inst, task);
    const vi = new CoreValueIter(flat);
    const result = liftFlatValues(cx, MAX_FLAT_PARAMS, vi, task.ft.results);
    task.return_(result);
  };
}
function createTaskCancel() {
  return () => {
    const task = currentTask();
    trapIf(!task.inst.mayLeave, "task.cancel: cannot leave component instance (may_leave violation)");
    trapIf(!task.opts.async_, "task.cancel from a non-async task");
    task.cancel();
  };
}
function createBackpressureInc(inst) {
  return () => {
    assert_(inst.backpressure >= 0 && inst.backpressure < 2 ** 16, "backpressure counter out of range");
    inst.backpressure += 1;
    trapIf(inst.backpressure === 2 ** 16, "backpressure counter overflow");
  };
}
function createBackpressureDec(inst) {
  return () => {
    assert_(inst.backpressure >= 0 && inst.backpressure < 2 ** 16, "backpressure counter out of range");
    inst.backpressure -= 1;
    trapIf(inst.backpressure < 0, "backpressure counter underflow");
  };
}
function createWaitableSetNew(inst) {
  return () => {
    trapIf(!inst.mayLeave, "waitable-set.new: cannot leave component instance");
    return inst.handles.add(new WaitableSet());
  };
}
function createWaitableSetWait(decl, ctx2, inst, mode = "plain") {
  const opts = ctx2.options(decl.options);
  const cancellable = opts.cancellable;
  return (si, ptr) => {
    trapIf(!inst.mayLeave, "waitable-set.wait: cannot leave component instance");
    const wset = requireWaitableSet(inst, si ?? 0, "waitable-set.wait");
    const task = currentTask();
    let event;
    if (task.deliverPendingCancel(cancellable)) {
      event = [
        EventCode.TASK_CANCELLED,
        0,
        0
      ];
    } else if (wset.hasPendingEvent()) {
      traceCopy(`waitable-set.wait si=${si} FAST (pending event)`);
      event = wset.getPendingEvent();
    } else if (mode === "jspi") {
      traceCopy(`waitable-set.wait si=${si} BLOCKS`);
      wset.numWaiting += 1;
      return blockCurrentActivation({
        store: inst.store,
        task,
        readyFunc: () => wset.hasPendingEvent(),
        cancellable,
        produce: (cancelled) => {
          wset.numWaiting -= 1;
          const ev = cancelled ? [
            EventCode.TASK_CANCELLED,
            0,
            0
          ] : wset.getPendingEvent();
          return unpackEvent(opts, inst, ptr ?? 0, ev);
        }
      });
    } else {
      needsJspi("waitable-set.wait with no pending event (the calling wasm frame must block; a callback-ABI guest should return the WAIT code instead)");
    }
    return unpackEvent(opts, inst, ptr ?? 0, event);
  };
}
function createWaitableSetPoll(decl, ctx2, inst) {
  const opts = ctx2.options(decl.options);
  const cancellable = opts.cancellable;
  return (si, ptr) => {
    trapIf(!inst.mayLeave, "waitable-set.poll: cannot leave component instance");
    const wset = requireWaitableSet(inst, si ?? 0, "waitable-set.poll");
    const event = wset.poll(currentTask(), cancellable);
    return unpackEvent(opts, inst, ptr ?? 0, event);
  };
}
function createWaitableSetDrop(inst) {
  return (i) => {
    trapIf(!inst.mayLeave, "waitable-set.drop: cannot leave component instance");
    const wset = inst.handles.remove(i ?? 0);
    trapIf(!(wset instanceof WaitableSet), "waitable-set.drop: handle is not a waitable set");
    wset.drop();
  };
}
function createWaitableJoin(inst) {
  return (wi, si) => {
    trapIf(!inst.mayLeave, "waitable.join: cannot leave component instance");
    const w = inst.handles.get(wi ?? 0);
    trapIf(!(w instanceof Waitable), "waitable.join: handle is not a waitable");
    trapIf(w.hasSyncWaiter, "waitable.join on a waitable with a synchronous waiter");
    if ((si ?? 0) === 0) {
      w.join(null);
      return;
    }
    const wset = requireWaitableSet(inst, si, "waitable.join");
    w.join(wset);
  };
}
function createSubtaskDrop(inst) {
  return (i) => {
    trapIf(!inst.mayLeave, "subtask.drop: cannot leave component instance");
    const s = inst.handles.remove(i ?? 0);
    trapIf(!(s instanceof Subtask), "subtask.drop: handle is not a subtask");
    s.drop();
  };
}
function finishSubtaskCancel(i, st) {
  return () => {
    const [code, index, payload] = st.getPendingEvent();
    assert_(code === EventCode.SUBTASK && index === (i ?? 0) && payload === st.state, "unexpected event delivered by subtask.cancel");
    assert_(st.resolveDelivered(), "subtask.cancel did not deliver the resolution");
    return st.state;
  };
}
function createSubtaskCancel(decl, inst, mode = "plain") {
  const async_ = decl.async === true;
  return (i) => {
    trapIf(!inst.mayLeave, "subtask.cancel: cannot leave component instance");
    const subtask = inst.handles.get(i ?? 0);
    trapIf(!(subtask instanceof Subtask), "subtask.cancel: handle is not a subtask");
    const st = subtask;
    const finish = finishSubtaskCancel(i, st);
    trapIf(st.resolveDelivered(), "subtask.cancel on a subtask whose resolution was already delivered");
    trapIf(st.cancellationRequested, "subtask.cancel on a subtask that was already cancelled");
    trapIf(st.inWaitableSet() && !async_, "synchronous subtask.cancel on a subtask that is in a waitable set");
    if (st.resolved()) {
      assert_(st.hasPendingEvent(), "resolved subtask without a pending event at cancellation");
    } else {
      st.cancellationRequested = true;
      assert_(st.onCancel !== null, "subtask.cancel on a subtask with no cancellation handler");
      st.onCancel(inst);
      if (!st.resolved()) {
        if (!async_) {
          if (mode === "jspi") {
            return blockCurrentActivation({
              store: inst.store,
              task: currentTask(),
              readyFunc: () => st.resolved(),
              cancellable: false,
              produce: () => finish()
            });
          }
          needsJspi("synchronous subtask.cancel whose callee did not resolve immediately (the calling wasm frame must block)");
        }
        if (mode === "jspi" && st.calleeTask !== null) {
          const t = st.calleeTask;
          const store2 = inst.store;
          const determinate = () => st.resolved() || t.threads.every((th) => th.done()) || store2.waiting.some((w) => w.task === st.calleeTask);
          if (!determinate()) {
            return blockCurrentActivation({
              store: inst.store,
              task: currentTask(),
              readyFunc: determinate,
              cancellable: false,
              produce: () => st.resolved() ? finish() : BLOCKED
            });
          }
          if (!st.resolved()) return BLOCKED;
          return finish();
        }
        return BLOCKED;
      }
    }
    return finish();
  };
}
function createThreadYield(decl, mode = "plain") {
  const cancellable = decl.cancellable === true;
  return () => {
    const thread = currentThread();
    trapIf(!thread.task.inst.mayLeave, "thread.yield: cannot leave component instance");
    if (thread.task.deliverPendingCancel(cancellable)) return 1;
    if (mode === "jspi") {
      return blockCurrentActivation({
        store: thread.task.inst.store,
        task: thread.task,
        readyFunc: () => true,
        cancellable,
        produce: (cancelled) => cancelled ? 1 : 0
      });
    }
    needsJspi("thread.yield (the calling wasm frame must block; a callback-ABI guest should return the YIELD code instead)");
  };
}
function requireWaitableSet(inst, si, what) {
  const wset = inst.handles.get(si);
  trapIf(!(wset instanceof WaitableSet), `${what}: handle ${si} is not a waitable set`);
  return wset;
}
function unpackEvent(opts, inst, ptr, e) {
  const [event, p1, p2] = e;
  const cx = new LiftLowerContext(cabiOptions(opts), inst, null);
  store(cx, p1, {
    kind: "u32"
  }, ptr);
  store(cx, p2, {
    kind: "u32"
  }, ptr + 4);
  return event;
}

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/runtime/src/intrinsics/fact_calls.ts
var PREPARE_ASYNC_NO_RESULT = 4294967295;
var PREPARE_ASYNC_WITH_RESULT = 4294967294;
var START_FLAG_ASYNC_CALLEE = 1;
var PREPARE_FIXED = 8;
function taskOptionsFor(prepared, callback, memory, calleeUsesAsyncAbi) {
  return {
    // NOTE the distinction definitions.py draws and this code initially got
    // wrong: `Task.ft.async` is the *function type*'s asyncness (what
    // `prepare-call` passes as `callee_async`), while `Task.opts.async_` is
    // the *canonical options*' asyncness — and `canon_lift` branches on the
    // latter (`if not opts.async_:` at line 2168). A function can be
    // async-*typed* yet lifted with sync options, in which case the reference
    // takes its plain synchronous path. Branching on the type instead sent
    // those callees down the stackful path and reported a bogus JSPI
    // requirement (`test/async/cross-abi-calls.wast`'s `async-calls-sync-*`).
    async_: calleeUsesAsyncAbi,
    callback: callback !== null,
    stringEncoding: stringEncodingName(prepared.stringEncoding),
    memory
  };
}
function stringEncodingName(v) {
  switch (v) {
    case 0:
      return "utf8";
    case 1:
      return "utf16";
    case 2:
      return "latin1+utf16";
    default:
      return "utf8";
  }
}
function createPrepareCall(decl, ctx2) {
  return (...args) => {
    assert_(args.length >= PREPARE_FIXED, `prepare-call: expected at least ${PREPARE_FIXED} arguments`);
    const [start, return_, callerI, calleeI, taskReturnType, calleeAsync, enc2, rc_] = args;
    assert_(typeof start === "function" && typeof return_ === "function", "prepare-call: start/return must be funcrefs");
    assert_(ctx2.prepared.current === null, "prepare-call with a preparation already outstanding");
    const params2 = args.slice(PREPARE_FIXED);
    const rc = Number(rc_) >>> 0;
    const lastParam = () => {
      assert_(params2.length > 0, "prepare-call: retptr missing");
      return params2[params2.length - 1];
    };
    let resultInfo;
    let asyncCallerWithResult = false;
    if (rc === PREPARE_ASYNC_WITH_RESULT) {
      resultInfo = {
        kind: "heap",
        retptr: lastParam()
      };
      asyncCallerWithResult = true;
    } else if (rc === PREPARE_ASYNC_NO_RESULT) {
      resultInfo = {
        kind: "stack"
      };
    } else if (rc > MAX_FLAT_RESULTS) {
      resultInfo = {
        kind: "heap",
        retptr: lastParam()
      };
    } else {
      resultInfo = {
        kind: "stack"
      };
    }
    ctx2.prepared.current = {
      start,
      return_,
      callerInst: ctx2.componentInstance(Number(callerI) >>> 0),
      calleeInst: ctx2.componentInstance(Number(calleeI) >>> 0),
      taskReturnType: Number(taskReturnType) >>> 0,
      calleeAsync: Number(calleeAsync) !== 0,
      stringEncoding: Number(enc2) >>> 0,
      resultCountOrMax: rc,
      params: params2,
      memory: decl.memory === null ? null : ctx2.memoryToken(decl.memory),
      resultInfo,
      asyncCallerWithResult
    };
  };
}
function mkCalleeTask(input) {
  const { prepared, callee, callback, postReturn, ctx: ctx2, calleeUsesAsyncAbi } = input;
  const mode = input.mode ?? "plain";
  const canBlock = input.canBlock ?? false;
  const memory = prepared.memory;
  const inst = prepared.calleeInst;
  const ft = {
    params: [],
    results: [],
    async: prepared.calleeAsync
  };
  const task = new Task(
    ft,
    taskOptionsFor(prepared, callback, memory, calleeUsesAsyncAbi),
    inst,
    // into the callee's flat params (fact/signature.rs:61).
    //
    // An async caller that has a result passes its retptr as the *last* flat
    // parameter; `[async-start]` does not declare it, so it is chopped off
    // here exactly as wasmtime does (concurrent.rs:2869-2876, "Async callers,
    // if they have a result, use the last parameter as a return pointer so
    // chop that off"). Sync callers forward everything directly.
    () => {
      ctx2.factStartScopes.push({
        taskScope: task,
        lenders: input.lenderScope
      });
      let calleeArgs;
      try {
        calleeArgs = callCore(prepared.start, prepared.asyncCallerWithResult ? prepared.params.slice(0, -1) : prepared.params);
      } finally {
        ctx2.factStartScopes.pop();
      }
      input.onStarted?.();
      return calleeArgs;
    },
    // results into the caller's (fact/signature.rs:145).
    (result) => {
      if (result === null) {
        input.onCallerResults(null);
        return;
      }
      const args = result;
      const withRetptr = prepared.resultInfo.kind === "heap" ? [
        ...args,
        prepared.resultInfo.retptr
      ] : args;
      input.onCallerResults(callCore(prepared.return_, withRetptr));
    }
  );
  task.factPassthrough = true;
  const body = function* (thread) {
    if (!(yield* task.enterImplicitThread(thread))) return;
    const calleeArgs = task.start();
    traceCopy(`mkCalleeTask callee canBlock=${canBlock} mode=${mode}`);
    const raw = yield* awaitCore(canBlock ? enterWasm(callee, mode) : callee, calleeArgs, thread);
    if (!calleeUsesAsyncAbi) {
      task.return_(raw);
      if (postReturn !== null) {
        assert_(inst.mayLeave, "post-return with may_leave already false");
        inst.mayLeave = false;
        callCore(postReturn, raw);
        inst.mayLeave = true;
        ctx2.stats.postReturnsRun++;
      }
      task.exitImplicitThread(thread);
      return;
    }
    if (callback === null) {
      normalizeCoreValues(raw, [], "stackful callee result");
      task.exitImplicitThread(thread);
      return;
    }
    const [packed] = normalizeCoreValues(raw, [
      "i32"
    ], "callee result");
    yield* runCallbackLoop({
      name: "fact-callee",
      task,
      thread,
      inst,
      callback,
      packed,
      stats: ctx2.stats
    });
    task.exitImplicitThread(thread);
  };
  return {
    task,
    body
  };
}
function takePrepared(ctx2, what) {
  const p = ctx2.prepared.current;
  assert_(p !== null, `${what} without a preceding prepare-call`);
  ctx2.prepared.current = null;
  return p;
}
function createSyncStartCall(decl, ctx2) {
  return (callee, _liftParamCount) => {
    const prepared = takePrepared(ctx2, "sync-start-call");
    assert_(typeof callee === "function", "sync-start-call: callee funcref");
    const callback = decl.callback === null ? null : ctx2.callback(decl.callback);
    let callerResults = null;
    const lentHandles = [];
    const lenderScope = {
      addLender(h) {
        h.numLends += 1;
        lentHandles.push(h);
      },
      releaseLenders() {
        for (const h of lentHandles) h.numLends -= 1;
        lentHandles.length = 0;
      }
    };
    const { task, body } = mkCalleeTask({
      prepared,
      callee,
      callback,
      postReturn: null,
      ctx: ctx2,
      // `sync-start-call` exists only for "sync-lowered import to async-lifted
      // export" (fact.rs:608), so the callee always uses the async ABI.
      calleeUsesAsyncAbi: true,
      mode: ctx2.suspensionMode,
      canBlock: ctx2.calleeCanBlock?.(callee) ?? false,
      onCallerResults: (r) => {
        callerResults = r ?? [];
      },
      lenderScope
    });
    trapIf(!prepared.calleeInst.mayEnterFrom(prepared.callerInst), "cannot enter component instance");
    prepared.calleeInst.enterFrom(prepared.callerInst);
    let ok = false;
    try {
      const thread = spawn(task, body);
      thread.resume();
      ok = true;
    } catch (e) {
      if (e instanceof NeedsJspi || e instanceof PendingCapability) {
        prepared.calleeInst.leaveTo(prepared.callerInst);
      }
      throw e;
    }
    if (ok) prepared.calleeInst.leaveTo(prepared.callerInst);
    if (callerResults === null) {
      if (ctx2.suspensionMode === "jspi") {
        return blockCurrentActivation({
          store: prepared.callerInst.store,
          task: currentTask(),
          readyFunc: () => callerResults !== null,
          cancellable: false,
          produce: () => {
            lenderScope.releaseLenders();
            return shapeResults(callerResults);
          }
        });
      }
      needsJspi("sync-start-call whose async-lifted callee did not resolve in its first activation (the caller's wasm frame must block)");
    }
    lenderScope.releaseLenders();
    return shapeResults(callerResults);
  };
}
function shapeResults(out) {
  if (out === null || out.length === 0) return void 0;
  if (out.length === 1) return out[0];
  return out;
}
function createAsyncStartCall(decl, ctx2) {
  return (callee, _paramCount, _resultCount, flags) => {
    const prepared = takePrepared(ctx2, "async-start-call");
    assert_(typeof callee === "function", "async-start-call: callee funcref");
    const callback = decl.callback === null ? null : ctx2.callback(decl.callback);
    const subtask = new Subtask();
    let onProgress2 = () => {
    };
    const { task, body } = mkCalleeTask({
      prepared,
      callee,
      callback,
      postReturn: decl.postReturn === null ? null : ctx2.callback(decl.postReturn),
      ctx: ctx2,
      // `compile_async_to_async_adapter` sets START_FLAG_ASYNC_CALLEE;
      // `compile_async_to_sync_adapter` passes 0 (trampoline.rs:508 and :764).
      calleeUsesAsyncAbi: ((flags ?? 0) & START_FLAG_ASYNC_CALLEE) !== 0,
      mode: ctx2.suspensionMode,
      canBlock: ctx2.calleeCanBlock?.(callee) ?? false,
      onStarted: () => {
        if (subtask.state === SubtaskState.STARTING) {
          subtask.state = SubtaskState.STARTED;
          onProgress2();
        }
      },
      onCallerResults: (r) => {
        if (!subtask.resolved()) {
          subtask.resolve(r === null ? subtask.state === SubtaskState.STARTING ? SubtaskState.CANCELLED_BEFORE_STARTED : SubtaskState.CANCELLED_BEFORE_RETURNED : SubtaskState.RETURNED, []);
        }
        onProgress2();
      },
      // Borrow lenders attach to the caller-side subtask, released by its
      // `deliverResolve` (definitions.py `Subtask.deliver_resolve`, line 904).
      lenderScope: subtask
    });
    subtask.onCancel = (callerInst) => task.requestCancellation(callerInst);
    subtask.calleeTask = task;
    trapIf(!prepared.calleeInst.mayEnterFrom(prepared.callerInst), "cannot enter component instance");
    prepared.calleeInst.enterFrom(prepared.callerInst);
    let ok = false;
    let thread;
    try {
      thread = spawn(task, body);
      thread.resume();
      ok = true;
    } catch (e) {
      if (e instanceof NeedsJspi || e instanceof PendingCapability) {
        prepared.calleeInst.leaveTo(prepared.callerInst);
      }
      throw e;
    }
    if (ok) prepared.calleeInst.leaveTo(prepared.callerInst);
    const report = () => {
      if (subtask.resolved()) {
        subtask.deliverResolve();
        traceCopy(`async-start-call -> RETURNED (eager)`);
        return SubtaskState.RETURNED;
      }
      const subtaski = prepared.callerInst.handles.add(subtask);
      onProgress2 = () => subtask.setSubtaskPendingEvent(subtaski);
      const packed = packSubtaskResult(subtask.state, subtaski);
      traceCopy(`async-start-call -> state=${subtask.state} i=${subtaski} packed=0x${packed.toString(16)}`);
      return packed;
    };
    if (ctx2.suspensionMode === "jspi") {
      const store2 = prepared.callerInst.store;
      const calleeInst = prepared.calleeInst;
      const callerTask = maybeCurrentTask();
      const gatedAtEntry = () => subtask.state === SubtaskState.STARTING && !subtask.resolved() && !thread.done() && thread.waiting();
      const determinate = () => gatedAtEntry() ? !store2.hasRunnableWork(calleeInst, callerTask) : subtask.resolved() || thread.done() || store2.waiting.some((w) => w.task === task);
      if (!determinate()) {
        return blockCurrentActivation({
          store: prepared.callerInst.store,
          task: currentTask(),
          readyFunc: determinate,
          cancellable: false,
          produce: () => report()
        });
      }
    }
    return report();
  };
}
function spawn(task, body) {
  let thread;
  thread = new Thread(task, function* () {
    yield* body(thread);
  }());
  return thread;
}

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/runtime/src/intrinsics/transcode.ts
var UTF16_TAG = 2147483648;
var TranscodeMemory = class {
  #provider;
  #label;
  constructor(provider, label2) {
    this.#provider = provider;
    this.#label = label2;
  }
  bytes() {
    const m = this.#provider();
    if (m === void 0) {
      throw new Error(`${this.#label} accessed before it was extracted`);
    }
    return new Uint8Array(m.buffer);
  }
};
var TRANSCODE_OPS = [
  "utf8-to-utf8",
  "utf16-to-utf16",
  "latin1-to-latin1",
  "latin1-to-utf16",
  "latin1-to-utf8",
  "utf16-to-compact-probably-utf16",
  "utf16-to-compact-utf16",
  "utf16-to-latin1",
  "utf16-to-utf8",
  "utf8-to-compact-utf16",
  "utf8-to-latin1",
  "utf8-to-utf16"
];
var utf8Fatal = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true
});
function decodeUtf8OrTrap(bytes) {
  try {
    return utf8Fatal.decode(bytes);
  } catch {
    trap("invalid utf8 encoding");
  }
}
function* decodeUtf16OrTrap(bytes, ptr, units) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 0;
  while (i < units) {
    const u = view.getUint16(ptr + 2 * i, true);
    if (u < 55296 || u > 57343) {
      i += 1;
      yield [
        u,
        1
      ];
      continue;
    }
    if (u >= 56320 || i + 1 >= units) trap("invalid utf16 encoding");
    const lo = view.getUint16(ptr + 2 * (i + 1), true);
    if (lo < 56320 || lo > 57343) trap("invalid utf16 encoding");
    i += 2;
    yield [
      65536 + (u - 55296 << 10) + (lo - 56320),
      2
    ];
  }
}
function utf8Len(cp) {
  if (cp < 128) return 1;
  if (cp < 2048) return 2;
  if (cp < 65536) return 3;
  return 4;
}
function encodeUtf8At(dst, at, cp) {
  if (cp < 128) {
    dst[at] = cp;
    return 1;
  }
  if (cp < 2048) {
    dst[at] = 192 | cp >> 6;
    dst[at + 1] = 128 | cp & 63;
    return 2;
  }
  if (cp < 65536) {
    dst[at] = 224 | cp >> 12;
    dst[at + 1] = 128 | cp >> 6 & 63;
    dst[at + 2] = 128 | cp & 63;
    return 3;
  }
  dst[at] = 240 | cp >> 18;
  dst[at + 1] = 128 | cp >> 12 & 63;
  dst[at + 2] = 128 | cp >> 6 & 63;
  dst[at + 3] = 128 | cp & 63;
  return 4;
}
function encodeUtf16At(view, base, at, cp) {
  if (cp < 65536) {
    view.setUint16(base + 2 * at, cp, true);
    return 1;
  }
  const c = cp - 65536;
  view.setUint16(base + 2 * at, 55296 + (c >> 10), true);
  view.setUint16(base + 2 * (at + 1), 56320 + (c & 1023), true);
  return 2;
}
function utf8Latin1UpTo(bytes, ptr, len) {
  let i = 0;
  while (i < len) {
    const b = bytes[ptr + i];
    if (b < 128) {
      i += 1;
    } else if (b === 194 || b === 195) {
      const next = i + 1 < len ? bytes[ptr + i + 1] : -1;
      if (next < 128 || next > 191) break;
      i += 2;
    } else {
      break;
    }
  }
  return i;
}
function inflateLatin1Bytes(dst, dstPtr, latin1Bytes) {
  for (let i = latin1Bytes - 1; i >= 0; i--) {
    dst[dstPtr + 2 * i] = dst[dstPtr + i];
    dst[dstPtr + 2 * i + 1] = 0;
  }
}
function snapshot(bytes, ptr, len) {
  return bytes.slice(ptr, ptr + len);
}
function createTranscoder(op, from, to) {
  switch (op) {
    // (srcPtr, srcLen, dstPtr) -> () --------------------------------------
    case "latin1-to-latin1":
      return (srcPtr, srcLen, dstPtr) => {
        const src = from.bytes();
        const dst = to.bytes();
        dst.set(snapshot(src, srcPtr, srcLen), dstPtr);
      };
    case "utf8-to-utf8":
      return (srcPtr, srcLen, dstPtr) => {
        const src = from.bytes();
        const copy = snapshot(src, srcPtr, srcLen);
        decodeUtf8OrTrap(copy);
        to.bytes().set(copy, dstPtr);
      };
    case "utf16-to-utf16":
      return (srcPtr, srcLen, dstPtr) => {
        const src = from.bytes();
        const copy = snapshot(src, srcPtr, 2 * srcLen);
        for (const _ of decodeUtf16OrTrap(copy, 0, srcLen)) {
        }
        to.bytes().set(copy, dstPtr);
      };
    case "latin1-to-utf16":
      return (srcPtr, srcLen, dstPtr) => {
        const src = snapshot(from.bytes(), srcPtr, srcLen);
        const dst = to.bytes();
        for (let i = 0; i < srcLen; i++) {
          dst[dstPtr + 2 * i] = src[i];
          dst[dstPtr + 2 * i + 1] = 0;
        }
      };
    // (srcPtr, srcLen, dstPtr) -> dstUnits ---------------------------------
    case "utf8-to-utf16":
      return (srcPtr, srcLen, dstPtr) => {
        const s = decodeUtf8OrTrap(snapshot(from.bytes(), srcPtr, srcLen));
        const dst = to.bytes();
        const view = new DataView(dst.buffer, dst.byteOffset, dst.byteLength);
        let units = 0;
        for (let i = 0; i < s.length && units < srcLen; i++) {
          view.setUint16(dstPtr + 2 * units, s.charCodeAt(i), true);
          units++;
        }
        return units;
      };
    case "utf16-to-compact-probably-utf16":
      return (srcPtr, srcLen, dstPtr) => {
        const src = snapshot(from.bytes(), srcPtr, 2 * srcLen);
        let allLatin1 = true;
        for (const [cp] of decodeUtf16OrTrap(src, 0, srcLen)) {
          if (cp > 255) allLatin1 = false;
        }
        const dst = to.bytes();
        dst.set(src, dstPtr);
        if (!allLatin1) return (srcLen | UTF16_TAG) >>> 0;
        for (let i = 0; i < srcLen; i++) dst[dstPtr + i] = dst[dstPtr + 2 * i];
        return srcLen;
      };
    // (srcPtr, srcLen, dstPtr) -> [srcRead, dstWritten] --------------------
    case "utf8-to-latin1":
      return (srcPtr, srcLen, dstPtr) => {
        const src = snapshot(from.bytes(), srcPtr, srcLen);
        const read = utf8Latin1UpTo(src, 0, srcLen);
        const dst = to.bytes();
        let written = 0;
        let i = 0;
        while (i < read) {
          const b = src[i];
          if (b < 128) {
            dst[dstPtr + written] = b;
            i += 1;
          } else {
            dst[dstPtr + written] = (b & 31) << 6 | src[i + 1] & 63;
            i += 2;
          }
          written++;
        }
        return [
          read,
          written
        ];
      };
    case "utf16-to-latin1":
      return (srcPtr, srcLen, dstPtr) => {
        const src = from.bytes();
        const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
        const out = [];
        for (let i = 0; i < srcLen; i++) {
          const u = view.getUint16(srcPtr + 2 * i, true);
          if (u > 255) break;
          out.push(u);
        }
        const dst = to.bytes();
        for (let i = 0; i < out.length; i++) dst[dstPtr + i] = out[i];
        return [
          out.length,
          out.length
        ];
      };
    // (srcPtr, srcLen, dstPtr, dstLen, firstPass) -> [srcRead, dstWritten] -
    case "utf16-to-utf8":
      return (srcPtr, srcLen, dstPtr, dstLen, firstPass) => {
        const src = snapshot(from.bytes(), srcPtr, 2 * srcLen);
        const dst = to.bytes();
        let srcRead = 0;
        let dstWritten = 0;
        let consumed = 0;
        for (const [cp, units] of decodeUtf16OrTrap(src, 0, srcLen)) {
          consumed += units;
          if (firstPass !== 0 && cp >= 128) break;
          const remaining = dstLen - dstWritten;
          if (remaining < 4 && remaining < utf8Len(cp)) break;
          srcRead = consumed;
          dstWritten += encodeUtf8At(dst, dstPtr + dstWritten, cp);
        }
        return [
          srcRead,
          dstWritten
        ];
      };
    case "latin1-to-utf8":
      return (srcPtr, srcLen, dstPtr, dstLen, firstPass) => {
        const src = snapshot(from.bytes(), srcPtr, srcLen);
        let stop = srcLen;
        if (firstPass !== 0) {
          for (let i = 0; i < srcLen; i++) {
            if (src[i] >= 128) {
              stop = i;
              break;
            }
          }
        }
        const dst = to.bytes();
        let read = 0;
        let written = 0;
        while (read < stop) {
          const b = src[read];
          const need = b < 128 ? 1 : 2;
          if (written + need > dstLen) break;
          written += encodeUtf8At(dst, dstPtr + written, b);
          read++;
        }
        return [
          read,
          written
        ];
      };
    // (srcPtr, srcLen, dstPtr, dstLen, latin1BytesSoFar) -> dstUnits -------
    case "utf8-to-compact-utf16":
      return (srcPtr, srcLen, dstPtr, _dstLen, latin1Bytes) => {
        const s = decodeUtf8OrTrap(snapshot(from.bytes(), srcPtr, srcLen));
        const dst = to.bytes();
        inflateLatin1Bytes(dst, dstPtr, latin1Bytes);
        const view = new DataView(dst.buffer, dst.byteOffset, dst.byteLength);
        let units = 0;
        for (let i = 0; i < s.length; i++) {
          view.setUint16(dstPtr + 2 * (latin1Bytes + units), s.charCodeAt(i), true);
          units++;
        }
        return units + latin1Bytes;
      };
    case "utf16-to-compact-utf16":
      return (srcPtr, srcLen, dstPtr, _dstLen, latin1Bytes) => {
        const src = snapshot(from.bytes(), srcPtr, 2 * srcLen);
        const dst = to.bytes();
        inflateLatin1Bytes(dst, dstPtr, latin1Bytes);
        const view = new DataView(dst.buffer, dst.byteOffset, dst.byteLength);
        let at = latin1Bytes;
        for (const [cp] of decodeUtf16OrTrap(src, 0, srcLen)) {
          at += encodeUtf16At(view, dstPtr, at, cp);
        }
        return srcLen + latin1Bytes;
      };
    default: {
      const exhaustive = op;
      throw new Error(`unknown transcode op ${exhaustive}`);
    }
  }
}

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/runtime/src/intrinsics/context.ts
var NUM_CONTEXT_SLOTS = 2;
function canonContextGet(i) {
  const thread = currentThread();
  assert_(i < NUM_CONTEXT_SLOTS, `context.get slot ${i} out of range`);
  const result = thread.storage[i];
  assert_(result < 2 ** 32, "context.get value out of i32 range");
  if (CTX_TRACE) trace(`get[${i}] -> ${result}`, thread);
  return result >>> 0;
}
var CTX_TRACE = (() => {
  try {
    return Deno.env.get("CE_CTX_TRACE") === "1";
  } catch {
    return false;
  }
})();
function ctxThreadId(t) {
  return dbgId(t);
}
function trace(msg, thread) {
  const a = ambientDebug();
  console.error(`[ctx] ${ctxThreadId(thread)} ${msg} storage=${JSON.stringify(thread.storage)} | stack=[${a.stack.map(ctxThreadId).join(",")}] claims=[${a.claims.map(ctxThreadId).join(",")}] resuming=${a.resuming === null ? "-" : ctxThreadId(a.resuming)}`);
}
function canonContextSet(i, v) {
  const thread = currentThread();
  assert_(i < NUM_CONTEXT_SLOTS, `context.set slot ${i} out of range`);
  if (CTX_TRACE) trace(`set[${i}] = ${v >>> 0}`, thread);
  thread.storage[i] = v >>> 0;
}
function createUnsafeIntrinsic(symbol) {
  const match = /^context-(get|set)-i32-(\d+)$/.exec(symbol);
  if (match === null) {
    throw new UnsupportedFeatureError("M2", `component imports the unsafe intrinsic '${symbol}', which has no portable meaning in a JS host (only context.{get,set} do)`);
  }
  const slot = Number(match[2]);
  trapIf(slot >= NUM_CONTEXT_SLOTS, `unsafe intrinsic '${symbol}' addresses context slot ${slot}, but a thread has ${NUM_CONTEXT_SLOTS}`);
  if (match[1] === "get") return () => canonContextGet(slot);
  return (v) => {
    canonContextSet(slot, (v ?? 0) >>> 0);
  };
}

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/runtime/src/intrinsics/mod.ts
var FACT_TRAP_MESSAGES = {
  9: "wasm `unreachable` instruction executed",
  17: "cannot enter component instance",
  23: "cannot leave component instance",
  24: "cannot block a synchronous task before returning",
  25: "invalid `char` bit pattern",
  30: "string content out-of-bounds",
  31: "list content out-of-bounds",
  32: "invalid variant discriminant",
  33: "unaligned pointer",
  46: "reference count overflow",
  49: "uncaught exception propagated out of component"
};
var TRAP_UNCAUGHT_EXCEPTION = 49;
var TRAMPOLINE_MILESTONE = {
  "lower-import": "M0",
  "trap": "M0",
  "enter-sync-call": "M0",
  "exit-sync-call": "M0",
  "resource-new": "M1",
  "resource-rep": "M1",
  "resource-drop": "M1",
  "transcoder": "M1",
  "resource-transfer-own": "M1",
  "resource-transfer-borrow": "M1"
};
function milestoneOf(kind) {
  return TRAMPOLINE_MILESTONE[kind] ?? "M2";
}
var SyncCallScope = class {
  numBorrows = 0;
  lenders = [];
  /**
   * definitions.py `Subtask.add_lender` (line 890) — note there is **no**
   * `own` check, and `lift_borrow` (line 1516) calls it unconditionally: a
   * component that received a borrow may lend it onward, and the borrow
   * handle's own `num_lends` is what blocks `resource.drop` on it until the
   * onward call returns (`canon_resource_drop`, line 2325, traps on
   * `num_lends != 0` for owning *and* borrowed handles alike).
   * wasmtime 47.0.3 `vm/component/resources.rs:285` (`resource_lift_borrow`)
   * agrees.
   */
  addLender(h) {
    h.numLends += 1;
    this.lenders.push(h);
  }
  /** definitions.py `Subtask.release_lenders`. */
  releaseLenders() {
    for (const h of this.lenders) h.numLends -= 1;
    this.lenders.length = 0;
  }
};
function createTrampoline(decl, ctx2) {
  const fn = createTrampolineBody(decl, ctx2);
  return (...args) => {
    try {
      return fn(...args);
    } catch (e) {
      ctx2.trapState.pending = e;
      throw e;
    }
  };
}
function sctx(ctx2) {
  return ctx2;
}
function declaredInstance(decl, ctx2) {
  const instance = decl.instance;
  assert_(typeof instance === "number", `trampoline '${decl.kind}' has no declared component instance`);
  return ctx2.componentInstance(instance);
}
var SCOPE_TRACE = (() => {
  try {
    return Deno.env.get("CE_SCOPE_TRACE") === "1";
  } catch {
    return false;
  }
})();
var taskIds = /* @__PURE__ */ new WeakMap();
var nextTaskId = 1;
function taskId(t) {
  if (t === void 0 || t === null) return "NONE(->ctx fallback)";
  let id = taskIds.get(t);
  if (id === void 0) {
    id = nextTaskId++;
    taskIds.set(t, id);
  }
  return `T${id}`;
}
function syncScopes(ctx2, site = "?") {
  const thread = maybeCurrentThread();
  const scopes = thread?.syncCallStack ?? ctx2.syncCallStack;
  if (SCOPE_TRACE) {
    console.error(`[scope] ${site} act=${taskId(thread)} depth=${scopes.length}`);
  }
  return scopes;
}
function createTrampolineBody(decl, ctx2) {
  switch (decl.kind) {
    case "lower-import": {
      const d = decl;
      return ctx2.loweredImport(d);
    }
    case "trap":
      return (code) => {
        if (code === TRAP_UNCAUGHT_EXCEPTION) {
          const pending = ctx2.trapState.pending;
          if (pending !== void 0) {
            throw pending;
          }
        }
        const message = code === void 0 ? void 0 : FACT_TRAP_MESSAGES[code];
        trap(message === void 0 ? `FACT adapter trap (code ${code ?? "?"})` : `wasm trap: ${message}`);
      };
    // Sync-call task bookkeeping (intrinsics.md §A: "degenerate-case
    // implementation in M0: assert-and-count"). wasmtime 47 signatures:
    // enter-sync-call/exit-sync-call take no wasm-visible arguments that we
    // act on in M0; balance is asserted at component teardown by tests.
    // Signatures (wasmtime-environ 47.0.3 `fact.rs:743,754`):
    //   async.enter-sync-call(caller_instance: i32, async: i32,
    //                         callee_instance: i32) -> ()
    //   async.exit-sync-call() -> ()
    case "enter-sync-call":
      return (_callerInstance, async_, _calleeInstance) => {
        void async_;
        ctx2.stats.enterSyncCalls++;
        const scopes = syncScopes(ctx2, "enter");
        scopes.push(new SyncCallScope());
      };
    case "exit-sync-call":
      return (..._args) => {
        ctx2.stats.exitSyncCalls++;
        assert_(ctx2.stats.exitSyncCalls <= ctx2.stats.enterSyncCalls, "exit-sync-call without matching enter-sync-call");
        const scope = syncScopes(ctx2, "exit").pop();
        assert_(
          scope !== void 0,
          // matching `enter` -- the bracket is attached to the wrong unit
          // again. See `Thread.syncCallStack`.
          "exit-sync-call with an empty sync-call stack"
        );
        trapIf(scope.numBorrows > 0, "cannot return from a call with outstanding borrow handles");
        scope.releaseLenders();
      };
    // Guest-side resource built-ins (sync paths of docs/architecture.md §7 over the cabi
    // handle tables). rep is always i32 in current wasmtime.
    case "resource-new": {
      const d = decl;
      const inst = ctx2.componentInstance(d.instance);
      const rt = ctx2.resourceToken(d.resource);
      return (rep) => canonResourceNew(inst, rt, rep >>> 0);
    }
    case "resource-rep": {
      const d = decl;
      const inst = ctx2.componentInstance(d.instance);
      const rt = ctx2.resourceToken(d.resource);
      return (handle) => canonResourceRep(inst, rt, handle >>> 0);
    }
    case "resource-drop": {
      const d = decl;
      const inst = ctx2.componentInstance(d.instance);
      const rt = ctx2.resourceToken(d.resource);
      return (handle) => {
        canonResourceDrop(inst, rt, handle >>> 0);
      };
    }
    // FACT resource transfer (contracts/intrinsics.md §A, wasmtime-environ
    // 47.0.3 `fact.rs:721` — signature `(i32 src_handle, i32 src_table,
    // i32 dst_table) -> i32 dst_handle`). These are the fused-adapter form of
    // `lift_own`/`lower_own` and `lift_borrow`/`lower_borrow`
    // (definitions.py) with the src/dst tables named by index rather than
    // implied by the running instance.
    // FACT string transcoders (contracts/intrinsics.md §B "M1"). The plan
    // carries the op name plus the source/destination `RuntimeMemoryIndex`es;
    // `./transcode.ts` holds the twelve operations.
    case "transcoder": {
      const d = decl;
      if (d.from64 || d.to64) {
        throw new UnsupportedFeatureError("M2", `transcoder '${d.op}' over a 64-bit linear memory`);
      }
      if (!TRANSCODE_OPS.includes(d.op)) {
        throw new UnsupportedFeatureError("M2", `unknown string transcode operation '${d.op}'`);
      }
      return createTranscoder(d.op, ctx2.runtimeMemory(d.from), ctx2.runtimeMemory(d.to));
    }
    // --- 0.3 async built-ins (contracts/intrinsics.md §B "M2") -------------
    // All ported in ./async_builtins.ts; the ones that would have to block a
    // wasm frame fail there, at the call site, with a JSPI-shaped message.
    case "task-return":
      return createTaskReturn(decl, ctx2);
    case "task-cancel":
      return createTaskCancel();
    // No `backpressure-set` case on purpose: wasmtime-environ 47.0.3 has only
    // `Trampoline::BackpressureInc` / `BackpressureDec`
    // (`component/info.rs:775,781`) — there is no `BackpressureSet` variant to
    // dispatch, so a case for it would be unreachable code implying a wire
    // shape that cannot occur. definitions.py still carries
    // `canon_backpressure_set` (line 2368), but it is dead there too; see
    // upstream-component-model-repo-findings.md CM-2, where we propose its
    // removal upstream.
    case "backpressure-inc":
      return createBackpressureInc(declaredInstance(decl, ctx2));
    case "backpressure-dec":
      return createBackpressureDec(declaredInstance(decl, ctx2));
    case "waitable-set-new":
      return createWaitableSetNew(declaredInstance(decl, ctx2));
    case "waitable-set-wait":
      return createWaitableSetWait(decl, ctx2, declaredInstance(decl, ctx2), ctx2.suspensionMode);
    case "waitable-set-poll":
      return createWaitableSetPoll(decl, ctx2, declaredInstance(decl, ctx2));
    case "waitable-set-drop":
      return createWaitableSetDrop(declaredInstance(decl, ctx2));
    case "waitable-join":
      return createWaitableJoin(declaredInstance(decl, ctx2));
    case "subtask-drop":
      return createSubtaskDrop(declaredInstance(decl, ctx2));
    case "subtask-cancel":
      return createSubtaskCancel(decl, declaredInstance(decl, ctx2), ctx2.suspensionMode);
    case "thread-yield":
      return createThreadYield(decl, ctx2.suspensionMode);
    // --- FACT cross-component calls (see ./fact_calls.ts) -----------------
    case "prepare-call":
      return createPrepareCall(decl, ctx2);
    case "sync-start-call":
      return createSyncStartCall(decl, ctx2);
    case "async-start-call":
      return createAsyncStartCall(decl, ctx2);
    // --- stream / future / error-context (see ./stream_builtins.ts) -------
    case "stream-new":
      return createStreamNew(decl, sctx(ctx2), declaredInstance(decl, ctx2));
    case "future-new":
      return createFutureNew(decl, sctx(ctx2), declaredInstance(decl, ctx2));
    case "stream-read":
      return createStreamRead(decl, sctx(ctx2), declaredInstance(decl, ctx2));
    case "stream-write":
      return createStreamWrite(decl, sctx(ctx2), declaredInstance(decl, ctx2));
    case "future-read":
      return createFutureRead(decl, sctx(ctx2), declaredInstance(decl, ctx2));
    case "future-write":
      return createFutureWrite(decl, sctx(ctx2), declaredInstance(decl, ctx2));
    case "stream-cancel-read":
      return createStreamCancelRead(decl, sctx(ctx2), declaredInstance(decl, ctx2));
    case "stream-cancel-write":
      return createStreamCancelWrite(decl, sctx(ctx2), declaredInstance(decl, ctx2));
    case "future-cancel-read":
      return createFutureCancelRead(decl, sctx(ctx2), declaredInstance(decl, ctx2));
    case "future-cancel-write":
      return createFutureCancelWrite(decl, sctx(ctx2), declaredInstance(decl, ctx2));
    case "stream-drop-readable":
      return createStreamDropReadable(decl, sctx(ctx2), declaredInstance(decl, ctx2));
    case "stream-drop-writable":
      return createStreamDropWritable(decl, sctx(ctx2), declaredInstance(decl, ctx2));
    case "future-drop-readable":
      return createFutureDropReadable(decl, sctx(ctx2), declaredInstance(decl, ctx2));
    case "future-drop-writable":
      return createFutureDropWritable(decl, sctx(ctx2), declaredInstance(decl, ctx2));
    case "error-context-new":
      return createErrorContextNew(decl, sctx(ctx2), declaredInstance(decl, ctx2));
    case "error-context-debug-message":
      return createErrorContextDebugMessage(decl, sctx(ctx2), declaredInstance(decl, ctx2));
    case "error-context-drop":
      return createErrorContextDrop(declaredInstance(decl, ctx2));
    case "stream-transfer":
      return createStreamTransfer(ctx2);
    case "future-transfer":
      return createFutureTransfer(ctx2);
    case "error-context-transfer":
      return createErrorContextTransfer(
        ctx2,
        // separate table section for them; the resource-table instance mapping
        // is the same index space wasmtime uses for the transfer's arguments.
        (t) => ctx2.resourceTableInstance(t)
      );
    case "resource-transfer-own":
      return (handle, srcTable, dstTable) => transferOwn(ctx2, handle >>> 0, srcTable, dstTable);
    case "resource-transfer-borrow":
      return (handle, srcTable, dstTable) => transferBorrow(ctx2, handle >>> 0, srcTable, dstTable);
    default:
      throw new UnsupportedFeatureError(milestoneOf(decl.kind) === "M1" ? "M1" : "M2", `component requires host trampoline '${decl.kind}'`);
  }
}
function transferOwn(ctx2, handle, srcTable, dstTable) {
  const src = ctx2.resourceTableInstance(srcTable);
  const dst = ctx2.resourceTableInstance(dstTable);
  const srcRt = ctx2.resourceToken(srcTable);
  const dstRt = ctx2.resourceToken(dstTable);
  const h = src.handles.remove(handle);
  trapIf(!(h instanceof ResourceHandle), "transfer-own: not a resource handle");
  const rh = h;
  trapIf(rh.rt !== srcRt, "transfer-own: resource type mismatch");
  trapIf(rh.numLends !== 0, "cannot remove owned resource while borrowed (handle still lent out)");
  trapIf(!rh.own, "transfer-own: expected an owning handle");
  return dst.handles.add(new ResourceHandle(dstRt, rh.rep, true));
}
function transferBorrow(ctx2, handle, srcTable, dstTable) {
  const src = ctx2.resourceTableInstance(srcTable);
  const dst = ctx2.resourceTableInstance(dstTable);
  const srcRt = ctx2.resourceToken(srcTable);
  const dstRt = ctx2.resourceToken(dstTable);
  const fact = ctx2.factStartScopes[ctx2.factStartScopes.length - 1];
  const stack = syncScopes(ctx2);
  const scope = stack[stack.length - 1];
  assert_(fact !== void 0 || scope !== void 0, "transfer-borrow outside an enter-sync-call/exit-sync-call bracket or FACT start window");
  const h = src.handles.get(handle);
  trapIf(!(h instanceof ResourceHandle), "transfer-borrow: not a resource handle");
  const rh = h;
  trapIf(rh.rt !== srcRt, "transfer-borrow: resource type mismatch");
  (fact?.lenders ?? scope).addLender(rh);
  if (dstRt.impl !== null && dstRt.impl === dst) return rh.rep;
  const borrowScope = fact !== void 0 ? fact.taskScope : scope;
  borrowScope.numBorrows += 1;
  return dst.handles.add(new ResourceHandle(dstRt, rh.rep, false, borrowScope));
}

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/runtime/src/exec/executor.ts
var SUSPENDABLE_TRACE = (() => {
  try {
    return Deno.env.get("CE_COPY_TRACE") === "1";
  } catch {
    return false;
  }
})();
var HostResourceType = class {
  options;
  constructor(options = {}) {
    this.options = options;
  }
};
function hostResourceType(options) {
  return new HostResourceType(options ?? {});
}
var moduleCache = /* @__PURE__ */ new WeakMap();
async function instantiateComponent(input) {
  const loaded = input.loadedPlan ?? loadPlan(input.plan);
  if (loaded.wire !== input.plan) {
    throw new PlanError("instantiateComponent: `loadedPlan` was converted from a different plan document than `plan`");
  }
  const executor = new Executor(loaded, input);
  await executor.verifyComponent();
  await executor.compileModules();
  executor.bindImportedResources();
  await executor.runInitializers();
  return executor.finish();
}
var Executor = class {
  wire;
  loaded;
  componentBytes;
  adapterBytes;
  hostImports;
  verifyHash;
  /** See `InstantiateInput.jspi` and jspi/bridge.ts's invariant. */
  suspensionMode;
  stats = newStats();
  modules = [];
  instances = [];
  componentInstances = /* @__PURE__ */ new Map();
  /**
   * One scheduler `Store` for the whole component, shared by every component
   * instance in it — matching definitions.py, where a linked graph of
   * `ComponentInstance`s shares the `Store` that owns the waiting-thread list
   * (`ComponentInstance.__init__` takes `store`). A per-instance store would
   * make a thread blocked in one instance invisible to a driving loop in
   * another.
   */
  store = new Store();
  /** Memoized `unsafe-intrinsic` core functions, by symbol. */
  unsafeIntrinsics = /* @__PURE__ */ new Map();
  /** The single in-flight FACT `prepare-call` state (intrinsics/fact_calls.ts). */
  preparedCall = {
    current: null
  };
  /**
   * One `LiveMemory` per `RuntimeMemoryIndex`, memoized.
   *
   * definitions.py's `LiftOptions.equal` (line 643) compares memories by
   * *identity* (`lhs.memory is rhs.memory`), and `canon_task_return` requires
   * the options at the `task.return` site to equal the lifted export's. A
   * fresh wrapper per `resolveOptions` call would make that comparison fail
   * for every component that actually uses a memory — it only ever passed
   * before because the async fixtures in play had `memory: null` on both
   * sides. Memoizing restores wasmtime's semantics, where the comparison is
   * on `RuntimeMemoryIndex`.
   */
  liveMemories = /* @__PURE__ */ new Map();
  /** Set by the entry/import wrapping sites; checked in `finish`. */
  wrappedEntries = false;
  wrappedImports = false;
  /** Record that an entry / import wrapping site ran under the current mode. */
  noteEntry() {
    if (this.suspensionMode === "jspi") this.wrappedEntries = true;
    return this.suspensionMode;
  }
  noteImport() {
    if (this.suspensionMode === "jspi") this.wrappedImports = true;
    return this.suspensionMode;
  }
  taskMayBlock = new WebAssembly.Global({
    value: "i32",
    mutable: true
  }, 1);
  // extract-* landing zones (index spaces per plan-format.md).
  memories = [];
  reallocs = [];
  postReturns = [];
  callbacks = [];
  tables = [];
  /** LoweredIndex -> RuntimeImportIndex (from lower-import initializers). */
  lowerings = /* @__PURE__ */ new Map();
  trampolineCache = /* @__PURE__ */ new Map();
  /**
   * ResourceIndex -> the host token bound to it (imported resource types).
   * Surfaced on the component handle for embedder introspection.
   */
  hostResourceTypes = /* @__PURE__ */ new Map();
  /** In-flight sync cross-component calls (see intrinsics `SyncCallScope`). */
  syncCallStack = [];
  /** In-flight FACT `[async-start]` borrow windows (intrinsics `FactStartScope`). */
  factStartScopes = [];
  /**
   * Core functions exported by a core instance that imports at least one
   * genuinely-blocking trampoline (`trampolineNeedsSuspension`, per
   * DECLARATION — the async form of a copy/cancel built-in never blocks and
   * does not mark) or a function from an already-marked instance. FACT
   * consults this to decide whether a callee needs its own `promising`
   * entry; wrapping one that cannot block forces asynchrony the ABI forbids
   * (an eagerly-completing callee must report RETURNED, not STARTED).
   *
   * Instance granularity is still an over-approximation — a module exporting
   * both a blocking and a non-blocking function marks both — but with two
   * mitigations it no longer produces wrong answers on the official corpus:
   *
   *   * per-declaration classification keeps async-form-only importers (and
   *     the FACT `[adapter-callee]*` pass-through wrappers reached through
   *     them) out of the set entirely;
   *   * a needlessly-wrapped callee no longer changes observable state:
   *     `async-start-call` parks the caller until the callee is determinate
   *     (fact_calls.ts), reconstructing the reference's synchronous
   *     run-to-first-block across the engine's microtask hops (jspi pin (j)).
   *
   * Per-FUNCTION reachability (a call-graph pass in the translator, where
   * wasmparser already is) would still shrink the set — as a wrapping-cost
   * optimization now, not a correctness need.
   */
  suspendableFuncs = /* @__PURE__ */ new WeakSet();
  /** Scratch: set by `importValue` while one module's imports are resolved. */
  sawBlockingImport = false;
  /** LoweredIndex-es whose host functions carry the `suspending()` brand —
   * populated by `buildLoweredImport`, read by `importValue` (A1). */
  suspendableLowerings = /* @__PURE__ */ new Set();
  /** Host trap held across a FACT exception barrier (see `HostTrapState`). */
  trapState = {
    pending: void 0
  };
  /** Export path -> why it has no runtime surface (see `buildExport`). */
  omittedExports = /* @__PURE__ */ new Map();
  constructor(loaded, input) {
    this.loaded = loaded;
    this.wire = loaded.wire;
    this.componentBytes = input.componentBytes;
    this.adapterBytes = input.adapters ?? /* @__PURE__ */ new Map();
    this.hostImports = input.imports ?? {};
    this.verifyHash = input.verifyHash ?? true;
    this.suspensionMode = chooseMode(
      input.jspi,
      // stackful async lift or a blocking built-in — per-declaration), and
      // the IMPORTS RECORD (a `suspending()`-marked host function: the
      // embedder's declared intent to park a sync-lowered frame, which no
      // plan field can express — embedder-api.md amendment A1).
      planNeedsSuspension(loaded.wire) || anySuspendingImport(this.hostImports)
    );
  }
  async verifyComponent() {
    const { sha256, len } = this.wire.component;
    if (this.componentBytes.length !== len) {
      throw new PlanError(`component byte length ${this.componentBytes.length} != plan's ${len}`);
    }
    if (!this.verifyHash) return;
    const digest = await crypto.subtle.digest(
      "SHA-256",
      // views and non-aligned oddities.
      this.componentBytes.slice().buffer
    );
    const hex = [
      ...new Uint8Array(digest)
    ].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (hex !== sha256) {
      throw new PlanError(`component sha256 mismatch: plan has ${sha256}, bytes are ${hex}`);
    }
  }
  async compileModules() {
    const cached = moduleCache.get(this.wire);
    if (cached !== void 0 && cached.componentBytes === this.componentBytes && this.wire.modules.every((m, i) => m.kind === "embedded" || cached.adapterRefs[i] === this.adapterBytes.get(m.file))) {
      this.modules.push(...await cached.modules);
      return;
    }
    const compiled = Promise.all(this.wire.modules.map((m, i) => {
      if (m.kind === "embedded") {
        const end = m.offset + m.len;
        if (end > this.componentBytes.length) {
          throw new PlanError(`module ${i}: byte range ${m.offset}..${end} exceeds component size ${this.componentBytes.length}`);
        }
        return WebAssembly.compile(this.componentBytes.slice(m.offset, end).buffer);
      }
      const bytes = this.adapterBytes.get(m.file);
      if (!bytes) {
        throw new PlanError(`adapter artifact ${m.file} not provided`);
      }
      if (bytes.length !== m.len) {
        throw new PlanError(`adapter ${m.file}: expected ${m.len} bytes, got ${bytes.length}`);
      }
      return WebAssembly.compile(bytes.slice().buffer);
    }));
    const entry = {
      componentBytes: this.componentBytes,
      adapterRefs: this.wire.modules.map((m) => m.kind === "embedded" ? void 0 : this.adapterBytes.get(m.file)),
      modules: compiled
    };
    moduleCache.set(this.wire, entry);
    void compiled.catch(() => {
      if (moduleCache.get(this.wire) === entry) moduleCache.delete(this.wire);
    });
    this.modules.push(...await compiled);
  }
  /**
   * Bind every imported resource type to the `HostResourceType` the embedder
   * supplied at the corresponding import path, before any initializer runs.
   *
   * Identity: all resource *tables* whose `resource` is this imported
   * ResourceIndex share the host token's dtor. `impl` stays null — an
   * imported resource is implemented by the host, not by any component
   * instance in this component, which is what the reference's
   * `ResourceType.impl` means (definitions.py `class ResourceType`).
   */
  bindImportedResources() {
    const imported = this.wire.importedResources ?? [];
    imported.forEach((ir, resourceIndex) => {
      const imp = this.wire.imports[ir.import];
      const label2 = importLabel(imp.name, imp.path);
      const value = this.lookupHostImport(imp.name, imp.path, label2);
      if (!(value instanceof HostResourceType)) {
        throw new PlanError(`host import '${label2}' must be a HostResourceType (the component imports a resource type); got ${describe(value)}`);
      }
      const dtor = value.options.dtor;
      this.wire.resourceTables.forEach((table, tableIndex) => {
        if (table.kind !== "concrete" || table.resource !== resourceIndex) {
          return;
        }
        const token = this.loaded.resourceTokens[tableIndex];
        token.impl = null;
        token.dtor = dtor === void 0 ? null : (rep) => dtor(rep);
      });
      this.hostResourceTypes.set(resourceIndex, value);
    });
  }
  async runInitializers() {
    for (const init of this.wire.initializers) {
      switch (init.op) {
        case "instantiate-module": {
          const module = this.modules[init.module];
          if (module === void 0) {
            throw new PlanError(`instantiate-module: no module ${init.module}`);
          }
          const declared = WebAssembly.Module.imports(module);
          if (declared.length !== init.args.length) {
            throw new PlanError(`module ${init.module}: ${declared.length} imports but ${init.args.length} args in plan`);
          }
          const importObject = {};
          this.sawBlockingImport = false;
          declared.forEach((imp, i) => {
            const before = this.sawBlockingImport;
            const value = this.importValue(init.args[i]);
            if (!before && this.sawBlockingImport && SUSPENDABLE_TRACE) {
              console.error(`[suspendable] module ${init.module}: import ${imp.module}.${imp.name} (${JSON.stringify(init.args[i])})`);
            }
            (importObject[imp.module] ??= {})[imp.name] = value;
          });
          let instance;
          try {
            instance = await WebAssembly.instantiate(module, importObject);
          } catch (e) {
            if (e?.constructor?.name === "SuspendError") {
              throw new Trap("cannot block a synchronous task before returning");
            }
            throw e;
          }
          if (this.sawBlockingImport) {
            for (const exported of Object.values(instance.exports)) {
              if (typeof exported === "function") {
                this.suspendableFuncs.add(exported);
              }
            }
          }
          this.instances.push(instance);
          break;
        }
        case "lower-import": {
          this.lowerings.set(init.index, init.import);
          break;
        }
        case "extract-memory": {
          const value = this.resolveCoreExport(init.export);
          if (!(value instanceof WebAssembly.Memory)) {
            throw new PlanError(`extract-memory ${init.index}: resolved to non-memory`);
          }
          this.memories[init.index] = value;
          break;
        }
        case "extract-realloc": {
          this.reallocs[init.index] = this.resolveFunction(init.def, `extract-realloc ${init.index}`);
          break;
        }
        case "extract-callback": {
          this.callbacks[init.index] = this.resolveFunction(init.def, `extract-callback ${init.index}`);
          break;
        }
        case "extract-post-return": {
          this.postReturns[init.index] = this.resolveFunction(init.def, `extract-post-return ${init.index}`);
          break;
        }
        case "extract-table": {
          const value = this.resolveCoreExport(init.export);
          if (!(value instanceof WebAssembly.Table)) {
            throw new PlanError(`extract-table ${init.index}: resolved to non-table`);
          }
          this.tables[init.index] = value;
          break;
        }
        case "resource": {
          const dtor = init.dtor === null ? null : this.resolveFunction(init.dtor, `resource ${init.index} dtor`);
          const inst = this.componentInstance(init.instance);
          const resourceIndex = resourceIndexOfDefined(this.loaded, init.index);
          this.wire.resourceTables.forEach((table, tableIndex) => {
            if (table.kind === "concrete" && table.resource === resourceIndex) {
              const token = this.loaded.resourceTokens[tableIndex];
              token.impl = inst;
              token.dtor = dtor === null ? null : (rep) => {
                dtor(rep);
              };
            }
          });
          break;
        }
        default: {
          const exhaustive = init;
          throw new PlanError(`unsupported initializer op ${exhaustive.op}`);
        }
      }
    }
  }
  finish() {
    const exports = {};
    for (const exp of this.wire.exports) {
      const built = this.buildExport(exp, exp.name);
      if (built.kind === "value") exports[exp.name] = built.value;
    }
    assertModeConsistent(this.suspensionMode, this.wrappedEntries, this.wrappedImports);
    const componentInstances = [];
    for (const [i, state] of this.componentInstances) {
      componentInstances[i] = state;
    }
    return {
      exports,
      stats: this.stats,
      componentInstances,
      coreInstances: this.instances,
      suspendableFuncs: this.suspendableFuncs,
      taskMayBlock: this.taskMayBlock,
      hostResourceTypes: this.hostResourceTypes,
      omittedExports: this.omittedExports,
      loadedPlan: this.loaded
    };
  }
  // -- export surface -------------------------------------------------------
  /**
   * Materialize one plan export.
   *
   * The result is an explicit discriminated union rather than
   * `unknown | undefined`: an earlier `if (built !== undefined)` filter meant
   * *any* path that happened to yield `undefined` removed the export from the
   * component's surface with no diagnostic anywhere. Only `type` exports are
   * legitimately absent from the runtime surface, and they say so with a
   * reason that is recorded on the handle (`omittedExports`); everything else
   * either produces a value or throws.
   */
  buildExport(exp, path) {
    switch (exp.kind) {
      case "lifted-func": {
        const ft = this.funcType(exp.type, `export '${path}'`);
        const core = this.resolveFunction(exp.coreDef, `export '${path}'`);
        const opts = this.resolveOptions(exp.options);
        const value = createLiftedFunction({
          name: path,
          ft,
          opts,
          core,
          stats: this.stats,
          suspensionMode: this.noteEntry(),
          trapState: this.trapState,
          syncCallStack: this.syncCallStack,
          allInstances: () => this.componentInstances.values()
        });
        if (this.suspensionMode === "jspi" && exp.name.startsWith("[constructor]")) {
          value[CONSTRUCTOR_SYNC_ENTRY] = createLiftedFunction({
            name: `${path} (sync entry)`,
            ft,
            opts,
            core,
            stats: this.stats,
            suspensionMode: "plain",
            trapState: this.trapState,
            syncCallStack: this.syncCallStack,
            allInstances: () => this.componentInstances.values()
          });
        }
        return {
          kind: "value",
          value
        };
      }
      case "instance": {
        const nested = {};
        for (const sub of exp.exports) {
          const built = this.buildExport(sub, `${path}/${sub.name}`);
          if (built.kind === "value") nested[sub.name] = built.value;
        }
        return {
          kind: "value",
          value: nested
        };
      }
      case "type":
        this.omittedExports.set(path, "type export: no runtime surface (plan-format.md)");
        return {
          kind: "omitted",
          reason: "type export: no runtime surface"
        };
      default: {
        const exhaustive = exp;
        throw new PlanError(`unsupported export kind ${exhaustive.kind}`);
      }
    }
  }
  // -- resolution -----------------------------------------------------------
  componentInstance(index) {
    let state = this.componentInstances.get(index);
    if (state === void 0) {
      state = new ComponentInstanceState(index, this.store);
      this.componentInstances.set(index, state);
    }
    return state;
  }
  /** Memoized `LiveMemory` for a `RuntimeMemoryIndex` (see `liveMemories`). */
  liveMemory(index) {
    let m = this.liveMemories.get(index);
    if (m === void 0) {
      m = new LiveMemory(() => this.memories[index], `memory ${index}`);
      this.liveMemories.set(index, m);
    }
    return m;
  }
  unsafeIntrinsic(symbol) {
    let fn = this.unsafeIntrinsics.get(symbol);
    if (fn === void 0) {
      fn = createUnsafeIntrinsic(symbol);
      this.unsafeIntrinsics.set(symbol, fn);
    }
    return fn;
  }
  /**
   * Resolve a core-instantiation argument.
   *
   * Identical to `resolveCoreDef` except that in jspi mode a *blocking-capable*
   * trampoline is handed to wasm as a `WebAssembly.Suspending`, so that
   * returning a Promise from it suspends the calling activation instead of
   * trapping. Only this path wraps: the same trampoline resolved anywhere the
   * host will *call* it from JS (extract-callback, post-return, realloc) must
   * stay an ordinary function.
   */
  importValue(def) {
    const value = this.resolveCoreDef(def);
    if (typeof value === "function" && this.suspendableFuncs.has(value)) {
      this.sawBlockingImport = true;
    }
    if (this.suspensionMode !== "jspi" || def.kind !== "trampoline" || typeof value !== "function") {
      return value;
    }
    const decl = this.wire.trampolines[def.index];
    if (decl === void 0) return value;
    const optionsAsync = (i) => this.wire.canonicalOptions[i]?.async === true;
    const d = decl;
    if (d.kind === "lower-import") {
      const lowered = d.lowered;
      if (!this.suspendableLowerings.has(lowered)) return value;
      this.sawBlockingImport = true;
      this.noteImport();
      return suspendingImport(value, "jspi");
    }
    if (!trampolineCanBlock(d, optionsAsync)) return value;
    if (trampolineNeedsSuspension(d, optionsAsync)) {
      this.sawBlockingImport = true;
    }
    this.noteImport();
    return suspendingImport(value, "jspi");
  }
  resolveCoreDef(def) {
    switch (def.kind) {
      case "export": {
        return this.resolveCoreExport({
          instance: def.instance,
          item: def.item
        });
      }
      case "instance-flags":
        return this.componentInstance(def.instance).flags;
      case "trampoline":
        return this.trampoline(def.index);
      case "unsafe-intrinsic":
        return this.unsafeIntrinsic(def.intrinsic);
      case "task-may-block":
        return this.taskMayBlock;
      default: {
        const exhaustive = def;
        throw new PlanError(`unsupported CoreDef kind ${exhaustive.kind}`);
      }
    }
  }
  resolveCoreExport(ref) {
    const instance = this.instances[ref.instance];
    if (instance === void 0) {
      throw new PlanError(`core export ref: runtime instance ${ref.instance} not created yet`);
    }
    const value = instance.exports[ref.item.name];
    if (value === void 0) {
      throw new PlanError(`core instance ${ref.instance} has no export '${ref.item.name}'`);
    }
    return value;
  }
  resolveFunction(def, what) {
    const value = this.resolveCoreDef(def);
    if (typeof value !== "function") {
      throw new PlanError(`${what}: resolved to non-function`);
    }
    return value;
  }
  trampoline(index) {
    const cached = this.trampolineCache.get(index);
    if (cached !== void 0) return cached;
    const decl = this.wire.trampolines[index];
    if (decl === void 0) {
      throw new PlanError(`no trampoline ${index} in plan`);
    }
    const fn = createTrampoline(decl, {
      componentInstance: (i) => this.componentInstance(i),
      resourceToken: (i) => {
        const token = this.loaded.resourceTokens[i];
        if (token === void 0) {
          throw new PlanError(`no resource table ${i} in plan`);
        }
        return token;
      },
      runtimeMemory: (i) => new TranscodeMemory(() => this.memories[i], `runtime memory ${i}`),
      resourceTableInstance: (i) => {
        const table = this.wire.resourceTables[i];
        if (table === void 0) {
          throw new PlanError(`no resource table ${i} in plan`);
        }
        if (table.kind !== "concrete") {
          throw new PlanError(`resource table ${i} is abstract (type-only) and has no runtime handle table`);
        }
        return this.componentInstance(table.instance);
      },
      options: (i) => this.resolveOptions(i),
      resultTypes: (i) => this.resultTypes(i),
      callback: (i) => {
        const fn2 = this.callbacks[i];
        if (fn2 === void 0) {
          throw new PlanError(`callback ${i} accessed before its extract-callback initializer ran`);
        }
        return fn2;
      },
      memoryToken: (i) => this.liveMemory(i),
      streamElem: (i) => {
        if (i >= this.loaded.streamElems.length) {
          throw new PlanError(`stream table ${i} is not in the plan's streamTables (plan v2)`);
        }
        return this.loaded.streamElems[i];
      },
      streamTableInstance: (i) => this.componentInstance(this.loaded.streamTableInstances[i] ?? 0),
      futureTableInstance: (i) => this.componentInstance(this.loaded.futureTableInstances[i] ?? 0),
      futureElem: (i) => {
        if (i >= this.loaded.futureElems.length) {
          throw new PlanError(`future table ${i} is not in the plan's futureTables (plan v2)`);
        }
        return this.loaded.futureElems[i];
      },
      prepared: this.preparedCall,
      suspensionMode: this.suspensionMode,
      calleeCanBlock: (fn2) => this.suspendableFuncs.has(fn2),
      syncCallStack: this.syncCallStack,
      factStartScopes: this.factStartScopes,
      trapState: this.trapState,
      loweredImport: (d) => this.buildLoweredImport(d),
      stats: this.stats
    });
    this.trampolineCache.set(index, fn);
    return fn;
  }
  buildLoweredImport(decl) {
    const importIndex = this.lowerings.get(decl.lowered);
    if (importIndex === void 0) {
      throw new PlanError(`lower-import trampoline: lowering ${decl.lowered} was never initialized (initializer order violation)`);
    }
    const imp = this.wire.imports[importIndex];
    if (imp === void 0) {
      throw new PlanError(`no import ${importIndex} in plan`);
    }
    const label2 = importLabel(imp.name, imp.path);
    const value = this.lookupHostImport(imp.name, imp.path, label2);
    if (typeof value !== "function") {
      throw new PlanError(`host import '${label2}' missing or not a function (got ${describe(value)})`);
    }
    const ft = this.funcType(decl.type, `import '${label2}'`);
    const opts = this.resolveOptions(decl.options);
    const suspendable = isSuspending(value);
    if (suspendable) this.suspendableLowerings.add(decl.lowered);
    return createLoweredImport({
      name: label2,
      ft,
      opts,
      hostFn: value,
      stats: this.stats,
      mode: this.suspensionMode,
      suspendable
    });
  }
  /**
   * Resolve one plan import against the host-provided import record: index by
   * the component's exact import string, then walk `path` (instance imports —
   * plan-format.md v0.1 amendment #4).
   */
  lookupHostImport(name, path, label2) {
    if (!(name in this.hostImports)) {
      throw new PlanError(`host import '${label2}' not provided (no key '${name}' in imports)`);
    }
    let value = this.hostImports[name];
    const walked = [];
    for (const segment of path) {
      if (value === null || typeof value !== "object") {
        throw new PlanError(`host import '${label2}': '${[
          name,
          ...walked
        ].join("/")}' is ${describe(value)}, expected an object to read '${segment}' from`);
      }
      value = value[segment];
      walked.push(segment);
    }
    return value;
  }
  /**
   * Element types of an interned *results tuple* — the `results` field of a
   * `task-return` trampoline (the shim interns a lifted function's result
   * list as a single tuple type, `intern_results_tuple`).
   */
  resultTypes(index) {
    const entry = this.loaded.types[index];
    if (entry === void 0) {
      throw new PlanError(`task-return results: no type ${index}`);
    }
    if (entry.kind !== "value" || entry.type.kind !== "tuple") {
      throw new PlanError(`task-return results: type ${index} is not a tuple type`);
    }
    return entry.type.elements;
  }
  funcType(index, what) {
    const entry = this.loaded.types[index];
    if (entry === void 0) throw new PlanError(`${what}: no type ${index}`);
    if (entry.kind !== "func") {
      throw new PlanError(`${what}: type ${index} is not a function type`);
    }
    return entry.funcType;
  }
  resolveOptions(index) {
    const wire = this.wire.canonicalOptions[index];
    if (wire === void 0) {
      throw new PlanError(`no canonicalOptions ${index} in plan`);
    }
    const memoryIndex = wire.memory;
    return {
      stringEncoding: wire.stringEncoding,
      memory: memoryIndex === null ? null : this.liveMemory(memoryIndex),
      realloc: wire.realloc === null ? null : () => this.reallocs[wire.realloc],
      postReturn: wire.postReturn === null ? null : () => this.postReturns[wire.postReturn],
      callback: wire.callback === null ? null : () => this.callbacks[wire.callback],
      async: wire.async,
      cancellable: wire.cancellable,
      coreType: wire.coreType,
      instance: this.componentInstance(wire.instance)
    };
  }
};
function importLabel(name, path) {
  return path.length === 0 ? name : `${name}/${path.join("/")}`;
}
function describe(v) {
  if (v === null) return "null";
  if (v === void 0) return "undefined";
  if (typeof v === "object") return `a ${v.constructor?.name ?? "object"}`;
  return `a ${typeof v}`;
}

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/runtime/src/exec/host_streams.ts
var HOST_INSTANCE = Object.freeze({
  hostEnd: true
});
var HostBuffer = class {
  t;
  values;
  length;
  progress;
  taken;
  constructor(t, values, length) {
    this.t = t;
    this.values = values;
    this.length = length;
    this.progress = 0;
    this.taken = [];
  }
  remain() {
    return this.length - this.progress;
  }
  isZeroLength() {
    return this.length === 0;
  }
  /** Guest side is reading from us. */
  read(n) {
    assert_(n <= this.remain(), "host buffer read beyond remaining");
    const out = this.values === null ? new Array(n).fill(null) : this.values.slice(this.progress, this.progress + n);
    this.progress += n;
    return out;
  }
  /** Guest side is writing into us. */
  write(vs) {
    assert_(vs.length <= this.remain(), "host buffer write beyond remaining");
    for (const v of vs) this.taken.push(v);
    this.progress += vs.length;
  }
};
var activityArms = /* @__PURE__ */ new WeakSet();
function quiescent(store2) {
  return store2.settled.length === 0 && store2.awaiting.size === 0 && !hasRealHostCall(store2);
}
function hasRealHostCall(store2) {
  for (const p of store2.pendingHostCalls) {
    if (!activityArms.has(p)) return true;
  }
  return false;
}
var HostActivity = class {
  #store = null;
  #promise = null;
  #resolve = null;
  #closed = false;
  #pumping = false;
  bind(store2) {
    if (this.#store !== null || this.#closed) return;
    this.#store = store2;
    this.#arm();
  }
  #arm() {
    if (this.#store === null || this.#promise !== null || this.#closed) return;
    this.#promise = new Promise((r) => this.#resolve = r);
    activityArms.add(this.#promise);
    this.#store.pendingHostCalls.add(this.#promise);
  }
  /** The embedder did something; let the driving loop re-pump. */
  notify() {
    const p = this.#promise, r = this.#resolve;
    this.#promise = null;
    this.#resolve = null;
    if (p !== null && this.#store !== null) this.#store.pendingHostCalls.delete(p);
    r?.();
    this.#arm();
  }
  /**
   * Drive the guest until it can make no more progress.
   *
   * A host operation that lands *between* export calls has no driving loop
   * running — `drive()` returned when the last export call resolved. So after
   * initiating a host read/write (or a drop) we pump the store ourselves.
   * Synchronously first (the common case: the guest is merely waiting on a
   * scheduler condition our rendezvous just satisfied, and the host op's
   * promise resolves before we return), then — if anything is still
   * outstanding — by handing the store to the *same* loop an export call
   * would have used, `driveStoreAsync`. Without the asynchronous half a guest
   * parked in a background forwarding task would never be resumed to consume
   * what we just offered, and the host read would await forever (C0 finding
   * R-1: the previous local drain only serviced `store.awaiting` and never
   * awaited `store.pendingHostCalls`, so a writer parked on a
   * Promise-returning host import stalled the reader).
   *
   * Traps from the synchronous half propagate to the caller of the host
   * operation, which is the only place that can report them.
   */
  pump() {
    const store2 = this.#store;
    if (store2 === null) return;
    for (; ; ) {
      const serviced = store2.serviceSettled();
      const ticked = store2.tick();
      if (!serviced && !ticked) break;
    }
    if (this.#pumping) return;
    if (quiescent(store2)) return;
    this.#pumping = true;
    void this.#pumpAsync(store2);
  }
  async #pumpAsync(store2) {
    try {
      while (!quiescent(store2)) {
        if (storeDriverDepth(store2) > 0) {
          await whenStoreDriverIdle(store2);
          continue;
        }
        await driveStoreAsync(
          store2,
          // moving; the host operation's own promise is what the caller
          // awaits. Three exit clauses:
          //
          //   * nothing left that a turn of the event loop could advance
          //     (`quiescent`);
          //   * `pendingHostCalls` empty, which is the precondition of BOTH
          //     of `driveAsync`'s deadlock traps. Returning true there keeps
          //     this between-calls pump from converting the documented
          //     embedder-never-acts hang (module header) into a trap that
          //     would surface, misattributed, on some later export call.
          //     Deadlock detection for genuine component deadlock stays where
          //     it belongs: in the driving loop of the export call the guest
          //     is blocked in;
          //   * another driver appeared (an export call started while we were
          //     parked) — hand the store back to it, per the single-driver
          //     rule. Our depth is 1 while we are inside, hence `> 1`.
          () => store2.pendingHostCalls.size === 0 || quiescent(store2) || storeDriverDepth(store2) > 1,
          "host stream/future activity"
        );
      }
    } catch (e) {
      store2.hostFailure ??= e;
    } finally {
      this.#pumping = false;
    }
    this.notify();
  }
  /** No further host activity is possible on this stream. */
  close() {
    const p = this.#promise, r = this.#resolve;
    this.#closed = true;
    this.#promise = null;
    this.#resolve = null;
    if (p !== null && this.#store !== null) this.#store.pendingHostCalls.delete(p);
    r?.();
  }
};
function bindOnLower(shared, activity) {
  const holder = shared;
  assert_(holder.onLowered == null, "this stream/future is already wrapped by a host end; hostStreamFor/hostFutureFor may wrap a shared object once");
  holder.onLowered = (inst) => activity.bind(inst.store);
  const bound = shared.boundStore;
  if (bound) activity.bind(bound);
}
function mkStreamEnds(shared, activity) {
  const parked = {
    read: false,
    write: false
  };
  const settle = (result) => {
    if (result === CopyResult.DROPPED) activity.close();
    else activity.notify();
  };
  return {
    writable: {
      write(values) {
        const buf = new HostBuffer(shared.t, values, values.length);
        return new Promise((resolve) => {
          parked.write = true;
          shared.write(
            HOST_INSTANCE,
            buf,
            // handed a COMPLETED event here and decide for itself whether to
            // re-offer; a host end has no event loop, so we make the useful
            // choice and **stay parked** until the offer is exhausted. That is
            // exactly the shape wit-bindgen's `wit_stream::new()` produces —
            // a background write that the reader drains a few elements at a
            // time — and it is why `reclaim` is deliberately not called while
            // values remain: reclaiming retires the pending buffer and the
            // next guest read would find nothing.
            (reclaim) => {
              if (buf.remain() > 0) return;
              reclaim();
              parked.write = false;
              activity.notify();
              resolve(buf.progress);
            },
            (result) => {
              parked.write = false;
              settle(result);
              resolve(buf.progress);
            }
          );
          activity.notify();
          activity.pump();
        });
      },
      async writeAll(values) {
        let sent = 0;
        while (sent < values.length && !shared.dropped) {
          const n = await this.write(values.slice(sent));
          if (n === 0) break;
          sent += n;
        }
        return sent;
      },
      cancelWrite() {
        if (!parked.write) return;
        parked.write = false;
        shared.cancel();
        activity.notify();
        activity.pump();
      },
      drop() {
        shared.drop();
        activity.close();
        activity.pump();
      }
    },
    readable: {
      read(max) {
        const buf = new HostBuffer(shared.t, null, max);
        return new Promise((resolve) => {
          parked.read = true;
          shared.read(HOST_INSTANCE, buf, (reclaim) => {
            reclaim();
            parked.read = false;
            activity.notify();
            resolve(buf.taken);
          }, (result) => {
            parked.read = false;
            settle(result);
            resolve(buf.taken);
          });
          activity.notify();
          activity.pump();
        });
      },
      cancelRead() {
        if (!parked.read) return;
        parked.read = false;
        shared.cancel();
        activity.notify();
        activity.pump();
      },
      drop() {
        shared.drop();
        activity.close();
        activity.pump();
      }
    }
  };
}
function hostStream(element) {
  const shared = new SharedStreamImpl(element);
  const activity = new HostActivity();
  bindOnLower(shared, activity);
  const ends = mkStreamEnds(shared, activity);
  return {
    ...ends,
    value: shared
  };
}
function hostStreamFor(value) {
  const shared = value;
  assert_(shared instanceof SharedStreamImpl, "hostStreamFor expects a lifted stream value");
  const activity = new HostActivity();
  bindOnLower(shared, activity);
  const ends = mkStreamEnds(shared, activity);
  return {
    ...ends,
    value
  };
}
function hostFuture(element) {
  const shared = new SharedFutureImpl(element);
  const activity = new HostActivity();
  bindOnLower(shared, activity);
  return mkFuture(shared, activity, shared);
}
function hostFutureFor(value) {
  const shared = value;
  assert_(shared instanceof SharedFutureImpl, "hostFutureFor expects a lifted future value");
  const activity = new HostActivity();
  bindOnLower(shared, activity);
  return mkFuture(shared, activity, value);
}
function mkFuture(shared, activity, value) {
  const parked = {
    any: false
  };
  const settle = (result) => {
    parked.any = false;
    if (result === CopyResult.DROPPED) activity.close();
    else activity.notify();
  };
  const self = {
    write(v) {
      const buf = new HostBuffer(shared.t, [
        v
      ], 1);
      return new Promise((resolve) => {
        parked.any = true;
        shared.write(HOST_INSTANCE, buf, (result) => {
          settle(result);
          resolve();
        });
        activity.notify();
        activity.pump();
      });
    },
    readResult() {
      if (shared.dropped) {
        return Promise.resolve({
          value: void 0,
          result: CopyResult.DROPPED
        });
      }
      const buf = new HostBuffer(shared.t, null, 1);
      return new Promise((resolve) => {
        parked.any = true;
        shared.read(HOST_INSTANCE, buf, (result) => {
          settle(result);
          resolve({
            value: buf.taken[0],
            result
          });
        });
        activity.notify();
        activity.pump();
      });
    },
    async read() {
      return (await self.readResult()).value;
    },
    cancel() {
      if (!parked.any) return;
      parked.any = false;
      shared.cancel();
      activity.notify();
      activity.pump();
    },
    drop() {
      shared.drop();
      activity.close();
      activity.pump();
    },
    value
  };
  return self;
}

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/runtime/src/embedder/casing.ts
function camelCase(label2) {
  const parts = label2.split("-");
  return parts[0] + parts.slice(1).map(upperFirst).join("");
}
function pascalCase(label2) {
  return label2.split("-").map(upperFirst).join("");
}
function upperFirst(s) {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}
var MANGLED = /^\[([a-z-]+)\](.*)$/;
function parseLeafName(raw) {
  const m = MANGLED.exec(raw);
  if (m === null) return {
    form: "plain",
    name: raw
  };
  const [, tag, rest] = m;
  switch (tag) {
    case "constructor":
      return {
        form: "constructor",
        resource: rest
      };
    case "method":
    case "static": {
      const dot = rest.indexOf(".");
      if (dot < 0) break;
      return {
        form: tag,
        resource: rest.slice(0, dot),
        member: rest.slice(dot + 1)
      };
    }
  }
  return {
    form: "plain",
    name: raw
  };
}

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/runtime/src/shim/translator.ts
var Translator = class _Translator {
  #exports;
  /**
   * sha256 of the shim wasm bytes this instance was built from, hex-encoded;
   * `null` when constructed from a pre-compiled `WebAssembly.Module` with no
   * bytes available (module identity can't be recovered post-compile).
   *
   * This is the honest translator "build hash" for the artifact cache
   * (docs/architecture.md §10): the wire envelope's `producer` block records
   * `{shimVersion, wasmtimeEnviron, features}`, which does NOT change when
   * the shim wasm is rebuilt from the same source versions (e.g. a local
   * patch or a different toolchain producing different codegen) — see the
   * M3-B dispatch. Digesting the actual bytes is the only sound cache key
   * component for translator identity.
   */
  buildHash;
  constructor(exports, buildHash) {
    this.#exports = exports;
    this.buildHash = buildHash;
    for (const name of [
      "memory",
      "ts_alloc",
      "ts_dealloc",
      "ts_translate"
    ]) {
      if (!(name in this.#exports)) {
        throw new PlanError(`shim module missing export '${name}'`);
      }
    }
  }
  /** Instantiate from compiled module or raw wasm bytes. */
  static async create(source) {
    let module;
    let buildHash = null;
    if (source instanceof WebAssembly.Module) {
      module = source;
    } else {
      module = await WebAssembly.compile(source.slice().buffer);
      const digest = await crypto.subtle.digest("SHA-256", source.slice().buffer);
      buildHash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    const instance = await WebAssembly.instantiate(module, {});
    return new _Translator(instance.exports, buildHash);
  }
  /**
   * Wrap an ALREADY-INSTANTIATED shim — the ESM wasm-module import path
   * (issue #16 delivery design): `import * as shim from ".../translator_shim.wasm"`
   * hands back an instantiated namespace (the shim imports nothing, so the
   * ESM integration instantiates it trivially), and this wraps it with no
   * further compile or copy.
   *
   * Sharing note: ESM gives ONE instance per realm, so every `fromExports`
   * wrapper over the same namespace shares linear memory. That is safe by
   * construction — `translate` is synchronous end-to-end (alloc → call →
   * copy out → dealloc within one JS frame), so calls can never interleave —
   * but treat the wrappers as equivalent, not independent.
   *
   * `buildHash` (hex sha-256 of the shim wasm bytes) cannot be recovered
   * from an instance; pass it when known — a published package can ship the
   * hash of the exact asset it carries — or leave it absent and the
   * artifact cache politely refuses to key on translator identity
   * (cache/core.ts).
   */
  static fromExports(exports, opts = {}) {
    return new _Translator(exports, opts.buildHash ?? null);
  }
  /** Translate a component binary into plan v0 + adapter artifacts. */
  translate(componentBytes) {
    const json = this.translateRaw(componentBytes);
    const { wire, adapters } = loadEnvelope(json);
    return {
      plan: wire,
      adapters,
      envelopeJson: json
    };
  }
  /** Translate, returning the raw envelope JSON without validation. */
  translateRaw(componentBytes) {
    const ex = this.#exports;
    const inPtr = ex.ts_alloc(componentBytes.length);
    new Uint8Array(ex.memory.buffer, inPtr, componentBytes.length).set(componentBytes);
    const outLenPtr = ex.ts_alloc(4);
    const outPtr = ex.ts_translate(inPtr, componentBytes.length, outLenPtr);
    const outLen = new DataView(ex.memory.buffer).getUint32(outLenPtr, true);
    const json = new TextDecoder().decode(new Uint8Array(ex.memory.buffer, outPtr, outLen));
    ex.ts_dealloc(outPtr, outLen);
    ex.ts_dealloc(outLenPtr, 4);
    ex.ts_dealloc(inPtr, componentBytes.length);
    return json;
  }
};

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/runtime/src/embedder/errors.ts
var WitError = class extends Error {
  payload;
  constructor(payload, message) {
    super(message ?? `WIT error: ${describePayload(payload)}`);
    this.name = "WitError";
    this.payload = payload;
  }
};
var DroppedError = class extends Error {
  constructor(message = "the write end was dropped without a value") {
    super(message);
    this.name = "DroppedError";
  }
};
var NameCollisionError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "NameCollisionError";
  }
};
var InvalidHandleError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidHandleError";
  }
};
function describePayload(p) {
  if (p === null || p === void 0) return String(p);
  if (typeof p === "object" && "tag" in p) {
    return String(p.tag);
  }
  if (typeof p === "object") return JSON.stringify(p);
  return String(p);
}

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/runtime/src/embedder/imports.ts
function toLoaded(input) {
  if ("wire" in input && "types" in input) return input;
  const wire = "plan" in input ? input.plan : input;
  return loadPlan(wire);
}
function requiredImports(input) {
  const loaded = toLoaded(input);
  return loaded.wire.imports.map((imp) => {
    const leaf = imp.path.length === 0 ? imp.name : imp.path[imp.path.length - 1];
    const member = parseLeafName(leaf);
    const out = {
      interfaceId: imp.name,
      path: [
        ...imp.path
      ],
      leaf,
      kind: imp.kind,
      member,
      jsName: jsNameOf(member, imp.kind)
    };
    if (member.form !== "plain") out.jsClass = pascalCase(member.resource);
    if (imp.type !== void 0) {
      const t = loaded.types[imp.type];
      if (t !== void 0 && t.kind === "func") {
        out.type = {
          params: t.funcType.params.map((p, i) => ({
            name: t.paramNames[i] ?? String(i),
            type: p
          })),
          results: t.funcType.results,
          async: t.funcType.async === true
        };
      }
    }
    return out;
  });
}
function jsNameOf(member, kind) {
  switch (member.form) {
    case "plain":
      return kind === "resource" ? pascalCase(member.name) : camelCase(member.name);
    case "constructor":
      return "constructor";
    case "method":
    case "static":
      return camelCase(member.member);
  }
}

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/runtime/src/embedder/resources.ts
var STATE = Symbol("deltic.resource-state");
var GuestResource = class {
  /** Drop the handle (alias of `[Symbol.dispose]`, so TS `using` works). */
  drop() {
    dropWrapper(this);
  }
  [Symbol.dispose]() {
    dropWrapper(this);
  }
};
var leaked = new FinalizationRegistry((s) => {
  if (s.valid && s.owns) {
    s.valid = false;
    try {
      s.rt.dtor?.(s.rep);
    } catch {
    }
  }
});
function initWrapper(w, state) {
  w[STATE] = state;
  if (state.owns) leaked.register(w, state, w);
}
function wrapperState(w) {
  return w[STATE];
}
function requireLive(w, what) {
  const s = wrapperState(w);
  if (s === void 0) {
    throw new InvalidHandleError(`${what}: not a resource handle`);
  }
  if (!s.valid) {
    throw new InvalidHandleError(`${what}: this ${s.className} handle is no longer valid (it was transferred as own<\u2026>, dropped, or was a borrow that outlived its call)`);
  }
  return s;
}
function dropWrapper(w) {
  const s = wrapperState(w);
  if (s === void 0 || !s.valid) return;
  s.valid = false;
  leaked.unregister(w);
  if (!s.owns) return;
  s.rt.dtor?.(s.rep);
}
function invalidateWrapper(w) {
  const s = wrapperState(w);
  if (s === void 0) return;
  s.valid = false;
  leaked.unregister(w);
}
function takeRep(w, own, what) {
  if (typeof w !== "object" || w === null) {
    throw new InvalidHandleError(`${what}: expected a resource class instance, got ${typeof w}`);
  }
  const s = requireLive(w, what);
  if (own) {
    s.valid = false;
    leaked.unregister(w);
  }
  return s.rep;
}
function buildGuestResourceClass(spec, rt, adapt, lowerArgs) {
  const className = pascalCase(spec.name);
  const cls = class extends GuestResource {
    constructor(...args) {
      super();
      if (spec.ctor === null) {
        throw new TypeError(`${className} has no WIT constructor; use its static functions`);
      }
      const where = `${className} constructor`;
      const lowered = lowerArgs(args, spec.ctorParams ?? [], where);
      const rep = spec.ctor(...lowered);
      if (rep !== null && typeof rep === "object" && "then" in rep) {
        throw new TypeError(`${where}: the guest constructor did not complete synchronously. A JS constructor cannot await; expose an async factory instead.`);
      }
      if (typeof rep !== "number") {
        throw new TypeError(`${where}: expected an own handle rep, got ${typeof rep}`);
      }
      initWrapper(this, {
        rep,
        valid: true,
        owns: true,
        rt,
        className
      });
    }
  };
  Object.defineProperty(cls, "name", {
    value: className
  });
  for (const m of spec.methods) {
    const js = camelCase(m.member);
    const where = `${className}.${js}`;
    Object.defineProperty(cls.prototype, js, {
      configurable: true,
      writable: true,
      value: function(...args) {
        return adapt(m.raw, m.params, m.results, where, [
          this,
          ...args
        ]);
      }
    });
  }
  for (const s of spec.statics) {
    const js = camelCase(s.member);
    const where = `${className}.${js} (static)`;
    Object.defineProperty(cls, js, {
      configurable: true,
      writable: true,
      value: (...args) => adapt(s.raw, s.params, s.results, where, args)
    });
  }
  return cls;
}
function makeWrapper(cls, rep, rt, owns) {
  const w = Object.create(cls.prototype);
  initWrapper(w, {
    rep,
    valid: true,
    owns,
    rt,
    className: cls.name ?? "resource"
  });
  return w;
}
var HostResourceRegistry = class {
  className;
  #byRep;
  #byInstance;
  #next;
  constructor(className) {
    this.className = className;
    this.#byRep = /* @__PURE__ */ new Map();
    this.#byInstance = /* @__PURE__ */ new WeakMap();
    this.#next = 1;
  }
  /** The host is passing an instance to the guest: allocate (or reuse) a rep. */
  repFor(instance) {
    if (instance === null || typeof instance !== "object") {
      throw new TypeError(`${this.className}: expected a class instance, got ${typeof instance}`);
    }
    const held = this.#byInstance.get(instance);
    if (held !== void 0 && this.#byRep.has(held)) return held;
    const rep = this.#next++;
    this.#byRep.set(rep, instance);
    this.#byInstance.set(instance, rep);
    return rep;
  }
  /** Is this instance already registered with a live rep? */
  hasInstance(instance) {
    if (instance === null || typeof instance !== "object") return false;
    const held = this.#byInstance.get(instance);
    return held !== void 0 && this.#byRep.has(held);
  }
  /** Is `rep` live? Diagnostics and white-box tests. */
  hasRep(rep) {
    return this.#byRep.has(rep);
  }
  /** Release a rep if it is still live; no dtor, no error when already gone. */
  releaseIfPresent(rep) {
    this.#byRep.delete(rep);
  }
  /** A `borrow<R>` arrived from the guest: the host's own instance, mapping kept. */
  lookup(rep) {
    const inst = this.#byRep.get(rep);
    if (inst === void 0) {
      throw new InvalidHandleError(`${this.className}: no live instance for rep ${rep}`);
    }
    return inst;
  }
  /**
   * An `own<R>` arrived from the guest: the host gets its instance back, the
   * guest's handle is gone, and **no dispose runs** (the contract's 2x4 table).
   */
  release(rep) {
    const inst = this.lookup(rep);
    this.#byRep.delete(rep);
    return inst;
  }
  /**
   * The guest dropped its last own handle: run the destructor. This is the
   * `HostResourceType` dtor the executor calls from `canon_resource_drop`.
   */
  dtor(rep) {
    const inst = this.#byRep.get(rep);
    if (inst === void 0) return;
    this.#byRep.delete(rep);
    inst[Symbol.dispose]?.();
  }
  /** Live handle count — diagnostics and tests. */
  get liveCount() {
    return this.#byRep.size;
  }
};

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/runtime/src/embedder/streams.ts
var StreamProducerError = class extends Error {
  cause;
  constructor(where, cause) {
    super(`${where}: the stream producer failed \u2014 ${describeCause(cause)}. The guest's stream is NOT closed cleanly: the in-flight call fails instead, because a short stream presented as end-of-stream would be wrong data reported as success.`);
    this.name = "StreamProducerError";
    this.cause = cause;
  }
};
function describeCause(e) {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
var producerFailures = /* @__PURE__ */ new WeakMap();
function reportProducerFailure(host, where, cause) {
  const err = cause instanceof StreamProducerError ? cause : new StreamProducerError(where, cause);
  const shared = host.value;
  producerFailures.set(host.value, err);
  const store2 = shared.boundStore;
  if (store2 != null && typeof store2 === "object") {
    if (store2.hostFailure === void 0) store2.hostFailure = err;
    return true;
  }
  return false;
}
function throwIfFailed(value) {
  const e = producerFailures.get(value);
  if (e !== void 0) throw e;
}
function isU8Element(element) {
  return element !== null && despecialize(element).kind === "u8";
}
var Stream = class _Stream {
  #host;
  #codec;
  /** Set once the handle's shared object has been handed to a guest. */
  #consumed = false;
  #dropped = false;
  /** Waiters parked in `Stream.create()` until an element type is known. */
  #binders = [];
  constructor(host, codec) {
    this.#host = host;
    this.#codec = codec;
  }
  /** Wrap a stream value that was lifted out of a guest. */
  static fromLifted(value, codec) {
    return new _Stream(hostStreamFor(value), codec);
  }
  /** Wrap a freshly created host-owned stream of a known element type. */
  static fromHostStream(host, codec) {
    return new _Stream(host, codec);
  }
  /**
   * `Stream.create<T>(): { stream, writer }` — the writer-side host end the
   * contract names.
   *
   * The element type is deliberately NOT a parameter: the embedder does not
   * have one (a `ValType` is a runtime-internal shape) and the *lowering site*
   * always does. So the shared object is created lazily, at the moment the
   * stream is passed to a guest, and writer operations issued before that park
   * until then. A stream created and written but never passed anywhere simply
   * never completes — the same honest hang the low-level layer documents.
   */
  static create() {
    const stream = new _Stream(null, null);
    return {
      stream,
      writer: new StreamWriter(stream)
    };
  }
  /** @internal — bind a lazily created stream to the lowering site's type. */
  bindElement(codec) {
    if (this.#host !== null) return;
    this.#codec = codec;
    this.#host = hostStream(codec.element);
    publishHostStream(this, this.#host);
    const waiters = this.#binders;
    this.#binders = [];
    for (const w of waiters) w();
  }
  /** @internal — resolve once this handle has a shared object. */
  whenBound() {
    if (this.#host !== null) return Promise.resolve();
    return new Promise((r) => this.#binders.push(r));
  }
  /** @internal */
  get bound() {
    return this.#host !== null;
  }
  /** @internal — the shared value to hand to a lowering site. */
  takeValue(codec) {
    this.bindElement(codec);
    if (this.#consumed) {
      throw new TypeError("this Stream handle has already been passed to a guest; a stream value may only be transferred once");
    }
    this.#consumed = true;
    return this.#host.value;
  }
  /** @internal */
  get codec() {
    return this.#codec;
  }
  #require() {
    if (this.#host === null) {
      throw new TypeError("this Stream was created with Stream.create() and has not been passed to a guest yet, so it has no element type; pass it first, or use the writer, which parks until then");
    }
    return this.#host;
  }
  /** Low-level read: up to `max` elements; an empty chunk means end-of-stream. */
  async read(max) {
    const host = this.#require();
    throwIfFailed(host.value);
    const raw = await host.readable.read(max);
    return this.#chunk(raw);
  }
  #chunk(raw) {
    const codec = this.#codec;
    if (isU8Element(codec.element)) {
      return Uint8Array.from(raw);
    }
    return raw.map((v) => codec.toHost(v));
  }
  /** Cancel an in-flight `read` (R-fix review advisory 1). */
  cancelRead() {
    this.#host?.readable.cancelRead();
  }
  drop() {
    if (this.#dropped) return;
    this.#dropped = true;
    this.#host?.readable.drop();
  }
  [Symbol.dispose]() {
    this.drop();
  }
  /** Web-native view: `ReadableStream<Chunk<T>>`. */
  readable() {
    const self = this;
    return new ReadableStream({
      async pull(controller) {
        const chunk = await self.read(READ_CHUNK);
        if (chunk.length === 0) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
      cancel() {
        self.drop();
      }
    });
  }
  async *[Symbol.asyncIterator]() {
    for (; ; ) {
      const chunk = await this.read(READ_CHUNK);
      if (chunk.length === 0) return;
      yield chunk;
    }
  }
};
var READ_CHUNK = 4096;
var StreamWriter = class {
  #stream;
  constructor(stream) {
    this.#stream = stream;
  }
  /** Offer values; resolves with how many the reader took. */
  async write(values) {
    await this.#stream.whenBound();
    const host = hostOf(this.#stream);
    throwIfFailed(host.value);
    const codec = this.#stream.codec;
    return await host.writable.write(values.map((v) => codec.fromHost(v)));
  }
  /** Offer values until all are taken or the reader goes away. */
  async writeAll(values) {
    await this.#stream.whenBound();
    const host = hostOf(this.#stream);
    throwIfFailed(host.value);
    const codec = this.#stream.codec;
    return await host.writable.writeAll(values.map((v) => codec.fromHost(v)));
  }
  cancelWrite() {
    if (!this.#stream.bound) return;
    hostOf(this.#stream).writable.cancelWrite();
  }
  /** End-of-stream. */
  async close() {
    await this.#stream.whenBound();
    hostOf(this.#stream).writable.drop();
  }
};
var hostOfStream = /* @__PURE__ */ new WeakMap();
function hostOf(s) {
  const h = hostOfStream.get(s);
  if (h === void 0) {
    throw new TypeError("stream writer used before the stream was bound");
  }
  return h;
}
function publishHostStream(s, h) {
  hostOfStream.set(s, h);
}
var Future = class _Future {
  /** Present once the underlying host end exists. */
  #host;
  /** Always present; resolves to the host end (immediately, when not deferred). */
  #hostP;
  #codec;
  #consumed = false;
  #settled = null;
  constructor(host, hostP, codec) {
    this.#host = host;
    this.#hostP = hostP;
    this.#codec = codec;
  }
  static fromLifted(value, codec) {
    const h = hostFutureFor(value);
    return new _Future(h, Promise.resolve(h), codec);
  }
  static fromHostFuture(host, codec) {
    return new _Future(host, Promise.resolve(host), codec);
  }
  /**
   * A future that is still in flight: the guest call that produces it has not
   * resolved yet.
   *
   * CONTRACT (contracts/embedder-api.md): §"Functions and async" makes every
   * export Promise-shaped, and §"Streams and futures" makes `Future<T>` a
   * `PromiseLike<T>`. For an export whose *result* is a `future<T>` those two
   * collide irreducibly: JS promise resolution unconditionally adopts a
   * thenable, so `await someExport()` can never hand back a thenable handle —
   * it hands back the value the handle would have yielded. Conservative
   * reading, implemented here: the export returns the handle **eagerly** (it
   * is itself PromiseLike, so `await` still works and still yields `T`), which
   * keeps `drop()`/`cancel()` reachable for a caller that does not await. The
   * alternative — resolving a Promise *to* the handle — is not expressible.
   * Flagged in the C2 report.
   */
  static deferred(pending, codec) {
    const f = new _Future(null, pending.then((v) => {
      const h = hostFutureFor(v);
      f.adopt(h);
      return h;
    }), codec);
    return f;
  }
  /** @internal */
  adopt(h) {
    this.#host = h;
  }
  /** @internal */
  takeValue() {
    if (this.#host === null) {
      throw new TypeError("this Future is still in flight and cannot be passed to a guest yet");
    }
    if (this.#consumed) {
      throw new TypeError("this Future handle has already been passed to a guest");
    }
    this.#consumed = true;
    return this.#host.value;
  }
  #read() {
    this.#settled ??= (async () => {
      const { value, result } = await (await this.#hostP).readResult();
      if (result !== CopyResult.COMPLETED) {
        throw new DroppedError(result === CopyResult.CANCELLED ? "the future read was cancelled" : "the future's write end was dropped without a value");
      }
      return this.#codec.toHost(value);
    })();
    return this.#settled;
  }
  then(onfulfilled, onrejected) {
    return this.#read().then(onfulfilled, onrejected);
  }
  cancel() {
    if (this.#host !== null) this.#host.cancel();
    else void this.#hostP.then((h) => h.cancel());
  }
  drop() {
    if (this.#host !== null) this.#host.drop();
    else void this.#hostP.then((h) => h.drop());
  }
  [Symbol.dispose]() {
    this.drop();
  }
};
var ErrorContext2 = class {
  message;
  /** @internal — the internal value, preserved so it can be lowered back. */
  internal;
  constructor(internal) {
    this.internal = internal;
    this.message = internal.debugMessage;
  }
};
function lowerStreamSource(src, codec) {
  if (src instanceof Stream) {
    return src.takeValue(codec);
  }
  const host = hostStream(codec.element);
  const stream = Stream.fromHostStream(host, codec);
  publishHostStream(stream, host);
  void pump(src, host, codec);
  return host.value;
}
async function pump(src, host, codec) {
  const where = codec.where ?? "stream producer";
  let failure;
  let produced = 0;
  try {
    for await (const batch of batches(src)) {
      const lowered = batch.map((v) => codec.fromHost(v));
      const n = await host.writable.writeAll(lowered);
      produced += n;
      if (n < lowered.length) break;
    }
  } catch (e) {
    failure = e;
  }
  if (failure !== void 0) {
    void produced;
    reportProducerFailure(host, where, failure);
  }
  host.writable.drop();
}
async function* batches(src) {
  if (isReadableStream(src)) {
    const reader = src.getReader();
    try {
      for (; ; ) {
        const { done, value } = await reader.read();
        if (done) return;
        yield asBatch(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  if (Symbol.asyncIterator in src) {
    for await (const v of src) yield asBatch(v);
    return;
  }
  for (const v of src) yield asBatch(v);
}
function asBatch(v) {
  if (v instanceof Uint8Array) return Array.from(v);
  if (Array.isArray(v)) return v;
  return [
    v
  ];
}
function isReadableStream(v) {
  return typeof ReadableStream !== "undefined" && v instanceof ReadableStream;
}
function lowerFutureSource(src, codec) {
  if (src instanceof Future) return src.takeValue();
  const host = hostFuture(codec.element);
  void (async () => {
    try {
      const v = await src;
      await host.write(codec.fromHost(v));
    } catch (e) {
      const reported = reportProducerFailure({
        value: host.value
      }, codec.where ?? "future producer", e);
      if (!reported) host.drop();
    }
  })();
  return host.value;
}

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/runtime/src/embedder/values.ts
var BorrowScope = class {
  #invalidate = [];
  add(f) {
    this.#invalidate.push(f);
  }
  end() {
    for (const f of this.#invalidate) f();
    this.#invalidate.length = 0;
  }
};
var NO_BORROWS = new BorrowScope();
var checkedLabels = /* @__PURE__ */ new WeakSet();
function checkNoCollisions(key, labels, what) {
  if (checkedLabels.has(key)) return;
  const seen = /* @__PURE__ */ new Map();
  for (const l of labels) {
    const js = camelCase(l);
    const held = seen.get(js);
    if (held !== void 0) {
      throw new NameCollisionError(`${what}: the labels '${held}' and '${l}' both map to the JS name '${js}'. Rename one in the WIT; the conventions layer will not guess which one wins.`);
    }
    seen.set(js, l);
  }
  checkedLabels.add(key);
}
function toHost(v, t, o, scope = NO_BORROWS, inOption = false) {
  switch (t.kind) {
    case "bool":
    case "s8":
    case "u8":
    case "s16":
    case "u16":
    case "s32":
    case "u32":
    case "s64":
    case "u64":
    case "f32":
    case "f64":
    case "char":
    case "string":
      return v;
    case "error-context":
      return new ErrorContext2(v);
    case "list": {
      const elem = despecialize(t.element);
      if (elem.kind === "u8") {
        return v instanceof Uint8Array ? v : Uint8Array.from(v);
      }
      return v.map((e) => toHost(e, t.element, o, scope));
    }
    case "record": {
      checkNoCollisions(t, t.fields.map((f) => f.label), `${o.where}: record`);
      const src = v;
      const out = {};
      for (const f of t.fields) {
        if (f.type.kind === "option") {
          const inner = src[f.label];
          if ("none" in inner) continue;
          out[camelCase(f.label)] = toHost(inner["some"], f.type.type, o, scope, true);
          continue;
        }
        out[camelCase(f.label)] = toHost(src[f.label], f.type, o, scope);
      }
      return out;
    }
    case "tuple": {
      const src = v;
      return t.elements.map((et, i) => toHost(src[String(i)], et, o, scope));
    }
    case "variant": {
      const [label2, payload] = single(v, o);
      const c = t.cases.find((c2) => c2.label === label2);
      if (c === void 0) {
        throw new TypeError(`${o.where}: unknown variant case '${label2}'`);
      }
      return c.type === null ? {
        tag: label2
      } : {
        tag: label2,
        val: toHost(payload, c.type, o, scope)
      };
    }
    case "enum": {
      const [label2] = single(v, o);
      return label2;
    }
    case "option": {
      const [label2, payload] = single(v, o);
      if (inOption) {
        return label2 === "none" ? {
          tag: "none"
        } : {
          tag: "some",
          val: toHost(payload, t.type, o, scope, true)
        };
      }
      return label2 === "none" ? void 0 : toHost(payload, t.type, o, scope, true);
    }
    case "result": {
      const [label2, payload] = single(v, o);
      const tag = label2 === "error" ? "err" : "ok";
      const ct = label2 === "error" ? t.error : t.ok;
      return ct === null ? {
        tag
      } : {
        tag,
        val: toHost(payload, ct, o, scope)
      };
    }
    case "flags": {
      checkNoCollisions(t, t.labels, `${o.where}: flags`);
      const src = v;
      const out = {};
      for (const l of t.labels) out[camelCase(l)] = Boolean(src[l]);
      return out;
    }
    case "map": {
      return toHost(v, despecialize(t), o, scope);
    }
    case "own":
      return o.bridge.liftOwn(v, t);
    case "borrow":
      return o.bridge.liftBorrow(v, t, scope);
    case "stream":
      return Stream.fromLifted(v, elemCodec(t.element, o));
    case "future":
      return Future.fromLifted(v, elemCodec(t.element, o));
  }
}
function single(v, o) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new TypeError(`${o.where}: expected a single-key case object, got ${describe2(v)}`);
  }
  const keys = Object.keys(v);
  if (keys.length !== 1) {
    throw new TypeError(`${o.where}: expected exactly one case key, got ${keys.length}`);
  }
  return [
    keys[0],
    v[keys[0]]
  ];
}
function fromHost(v, t, o, inOption = false) {
  switch (t.kind) {
    case "bool":
      return Boolean(v);
    case "u8":
      return int(v, t.kind, 0, 255, o);
    case "u16":
      return int(v, t.kind, 0, 65535, o);
    case "u32":
      return int(v, t.kind, 0, 4294967295, o);
    case "s8":
      return int(v, t.kind, -128, 127, o);
    case "s16":
      return int(v, t.kind, -32768, 32767, o);
    case "s32":
      return int(v, t.kind, -2147483648, 2147483647, o);
    case "u64":
      return big(v, t.kind, 0n, (1n << 64n) - 1n, o);
    case "s64":
      return big(v, t.kind, -(1n << 63n), (1n << 63n) - 1n, o);
    case "f32":
    case "f64":
      if (typeof v !== "number") {
        throw new TypeError(`${o.where}: ${t.kind} expects a number`);
      }
      return v;
    case "char": {
      if (typeof v !== "string" || [
        ...v
      ].length !== 1) {
        throw new TypeError(`${o.where}: char expects a single-code-point string`);
      }
      const cp = v.codePointAt(0);
      if (cp >= 55296 && cp <= 57343) {
        throw new TypeError(`${o.where}: char expects a Unicode scalar value, got the lone surrogate U+${cp.toString(16).toUpperCase()}`);
      }
      return v;
    }
    case "string":
      if (typeof v !== "string") {
        throw new TypeError(`${o.where}: string expects a string`);
      }
      return v;
    case "error-context": {
      if (v instanceof ErrorContext2) {
        return v.internal;
      }
      if (v instanceof ErrorContext) return v;
      throw new TypeError(`${o.where}: expected an ErrorContext`);
    }
    case "list": {
      const elem = despecialize(t.element);
      if (elem.kind === "u8") {
        if (v instanceof Uint8Array) return v;
        if (Array.isArray(v)) return Uint8Array.from(v);
        throw new TypeError(`${o.where}: list<u8> expects a Uint8Array`);
      }
      if (!Array.isArray(v)) {
        throw new TypeError(`${o.where}: list expects an array`);
      }
      return v.map((e) => fromHost(e, t.element, o));
    }
    case "record": {
      if (v === null || typeof v !== "object") {
        throw new TypeError(`${o.where}: record expects an object`);
      }
      checkNoCollisions(t, t.fields.map((f) => f.label), `${o.where}: record`);
      const src = v;
      const out = {};
      for (const f of t.fields) {
        const key = camelCase(f.label);
        if (f.type.kind === "option") {
          const inner = src[key];
          out[f.label] = inner === void 0 ? {
            none: null
          } : {
            some: fromHost(inner, f.type.type, o, true)
          };
          continue;
        }
        if (!(key in src)) {
          throw new TypeError(`${o.where}: record field '${key}' is missing`);
        }
        out[f.label] = fromHost(src[key], f.type, o);
      }
      return out;
    }
    case "tuple": {
      if (!Array.isArray(v) || v.length !== t.elements.length) {
        throw new TypeError(`${o.where}: tuple expects an array of ${t.elements.length}`);
      }
      const out = {};
      t.elements.forEach((et, i) => {
        out[String(i)] = fromHost(v[i], et, o);
      });
      return out;
    }
    case "variant": {
      const { tag, val, has } = tagged(v, o);
      const c = t.cases.find((c2) => c2.label === tag);
      if (c === void 0) {
        throw new TypeError(`${o.where}: unknown variant case '${tag}'`);
      }
      if (c.type === null) return {
        [tag]: null
      };
      if (!has) {
        throw new TypeError(`${o.where}: variant case '${tag}' needs a 'val'`);
      }
      return {
        [tag]: fromHost(val, c.type, o)
      };
    }
    case "enum": {
      if (typeof v !== "string" || !t.labels.includes(v)) {
        throw new TypeError(`${o.where}: enum expects one of ${t.labels.join(" | ")}, got ` + describe2(v));
      }
      return {
        [v]: null
      };
    }
    case "option": {
      if (inOption) {
        const { tag, val, has } = tagged(v, o);
        if (tag === "none") return {
          none: null
        };
        if (tag !== "some") {
          throw new TypeError(`${o.where}: a nested option must be { tag: "some" | "none" }`);
        }
        return {
          some: has ? fromHost(val, t.type, o, true) : null
        };
      }
      return v === void 0 ? {
        none: null
      } : {
        some: fromHost(v, t.type, o, true)
      };
    }
    case "result": {
      const { tag, val, has } = tagged(v, o);
      if (tag !== "ok" && tag !== "err") {
        throw new TypeError(`${o.where}: a result value must be { tag: "ok" | "err" }`);
      }
      const label2 = tag === "err" ? "error" : "ok";
      const ct = tag === "err" ? t.error : t.ok;
      if (ct === null) return {
        [label2]: null
      };
      if (!has) {
        throw new TypeError(`${o.where}: result case '${tag}' carries a payload and needs a 'val'`);
      }
      return {
        [label2]: fromHost(val, ct, o)
      };
    }
    case "flags": {
      if (v === null || typeof v !== "object") {
        throw new TypeError(`${o.where}: flags expects an object`);
      }
      checkNoCollisions(t, t.labels, `${o.where}: flags`);
      const src = v;
      const out = {};
      for (const l of t.labels) out[l] = Boolean(src[camelCase(l)]);
      return out;
    }
    case "map":
      return fromHost(v, despecialize(t), o);
    case "own":
      return o.bridge.lowerOwn(v, t);
    case "borrow":
      return o.bridge.lowerBorrow(v, t);
    case "stream":
      return lowerStreamSource(v, elemCodec(t.element, o));
    case "future":
      return lowerFutureSource(v, elemCodec(t.element, o));
  }
}
function tagged(v, o) {
  if (v === null || typeof v !== "object" || !("tag" in v)) {
    throw new TypeError(`${o.where}: expected a { tag, val? } value, got ${describe2(v)}`);
  }
  const rec = v;
  if (typeof rec.tag !== "string") {
    throw new TypeError(`${o.where}: 'tag' must be a string`);
  }
  return {
    tag: rec.tag,
    val: rec.val,
    has: "val" in rec
  };
}
function int(v, kind, lo, hi, o) {
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new TypeError(`${o.where}: ${kind} expects an integer number`);
  }
  if (v < lo || v > hi) {
    throw new TypeError(`${o.where}: ${kind} out of range: ${v}`);
  }
  return v;
}
function big(v, kind, lo, hi, o) {
  if (typeof v !== "bigint") {
    throw new TypeError(`${o.where}: ${kind} expects a bigint`);
  }
  if (v < lo || v > hi) {
    throw new TypeError(`${o.where}: ${kind} out of range: ${v}`);
  }
  return v;
}
function elemCodec(element, o) {
  return {
    element,
    where: o.where,
    toHost: (v) => element === null ? void 0 : toHost(v, element, o),
    fromHost: (v) => element === null ? null : fromHost(v, element, o)
  };
}
function describe2(v) {
  if (v === null) return "null";
  if (v === void 0) return "undefined";
  if (typeof v === "object") return `a ${v.constructor?.name ?? "object"}`;
  return `a ${typeof v} (${String(v)})`;
}

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/runtime/src/embedder/version.ts
var ImportRegistrationError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ImportRegistrationError";
  }
};
var ImportResolutionError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ImportResolutionError";
  }
};
var SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;
function parseInterfaceId(id) {
  const at = id.lastIndexOf("@");
  if (at < 0) return {
    base: id,
    version: null,
    semver: null
  };
  const base = id.slice(0, at);
  const version = id.slice(at + 1);
  return {
    base,
    version,
    semver: parseSemver(version)
  };
}
function parseSemver(v) {
  const m = SEMVER.exec(v);
  if (m === null) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] === void 0 ? [] : m[4].split("."),
    build: m[5] ?? null
  };
}
function trackKeyOf(base, v) {
  if (v.prerelease.length > 0) return null;
  if (v.major > 0) return `${base}@${v.major}`;
  if (v.minor > 0) return `${base}@0.${v.minor}`;
  return null;
}
function asTrackKeySpelling(id) {
  const p = parseInterfaceId(id);
  if (p.version === null || p.semver !== null) return null;
  if (/^\d+$/.test(p.version)) return p.version === "0" ? null : id;
  if (/^0\.\d+$/.test(p.version)) return id;
  return null;
}
var ImportResolver = class {
  #exact = /* @__PURE__ */ new Map();
  #tracks = /* @__PURE__ */ new Map();
  /** base id -> the unversioned key registered for it, if any. */
  #unversioned = /* @__PURE__ */ new Map();
  constructor(record) {
    for (const key of Object.keys(record)) {
      if (this.#exact.has(key)) {
        throw new ImportRegistrationError(`duplicate import key '${key}'`);
      }
      this.#exact.set(key, record[key]);
      this.#register(key);
    }
  }
  #register(key) {
    const trackSpelling = asTrackKeySpelling(key);
    if (trackSpelling !== null) {
      this.#claim(trackSpelling, {
        key,
        version: null
      });
      return;
    }
    const p = parseInterfaceId(key);
    if (p.version === "0") {
      throw new ImportRegistrationError(`import key '${key}': '@0' is not a compatibility track. Major 0 tracks the MINOR version (\`@0.2\`), so no version canonicalizes to '@0' and this registration could never be resolved.`);
    }
    if (p.version === null) {
      if (p.base.includes("/") || p.base.includes(":")) {
        this.#unversioned.set(p.base, key);
      }
      return;
    }
    if (p.semver === null) return;
    const track = trackKeyOf(p.base, p.semver);
    if (track !== null) this.#claim(track, {
      key,
      version: p.semver
    });
  }
  #claim(track, claim) {
    const held = this.#tracks.get(track);
    if (held === void 0) {
      this.#tracks.set(track, claim);
      return;
    }
    if (held.version === null !== (claim.version === null)) {
      const [t, f] = held.version === null ? [
        held.key,
        claim.key
      ] : [
        claim.key,
        held.key
      ];
      throw new ImportRegistrationError(`import registration is ambiguous on compatibility track '${track}': the track key '${t}' and the full version '${f}' are both registered. Register one or the other, never both.`);
    }
    if (held.version === null) {
      throw new ImportRegistrationError(`compatibility track '${track}' is claimed twice ('${held.key}' and '${claim.key}')`);
    }
    if (compareSemver(claim.version, held.version) > 0) {
      this.#tracks.set(track, claim);
    }
  }
  /** Every registered key, in registration order. */
  keys() {
    return [
      ...this.#exact.keys()
    ];
  }
  /**
   * Resolve one component import name. Returns `undefined` when nothing is
   * registered for it; throws when a registration *nearly* matches in a way
   * the contract bans (unversioned folding), because silently reporting
   * "not provided" would hide the real mistake.
   */
  resolve(id) {
    if (this.#exact.has(id)) return {
      key: id,
      value: this.#exact.get(id)
    };
    const p = parseInterfaceId(id);
    if (p.semver !== null) {
      const track = trackKeyOf(p.base, p.semver);
      if (track !== null) {
        const claim = this.#tracks.get(track);
        if (claim !== void 0) {
          return {
            key: claim.key,
            value: this.#exact.get(claim.key)
          };
        }
      }
      const un = this.#unversioned.get(p.base);
      if (un !== void 0) {
        throw new ImportResolutionError(`import '${id}' is versioned but the only registration for '${p.base}' is the unversioned key '${un}'. Version-agnostic folding is banned (contracts/embedder-api.md, C0 finding D-1): register '${p.base}@${p.version}' or the compatibility-track key '${trackKeyOf(p.base, p.semver) ?? p.base + "@" + p.version}'.`);
      }
      return void 0;
    }
    if (p.version === null) {
      const near = [
        ...this.#exact.keys()
      ].filter((k) => parseInterfaceId(k).base === p.base);
      if (near.length > 0) {
        throw new ImportResolutionError(`import '${id}' is unversioned but the registrations for it are versioned (${near.join(", ")}). Version-agnostic folding is banned (contracts/embedder-api.md, C0 finding D-1).`);
      }
    }
    return void 0;
  }
};
function compareSemver(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  const ap = a.prerelease, bp = b.prerelease;
  if (ap.length === 0 && bp.length === 0) return 0;
  if (ap.length === 0) return 1;
  if (bp.length === 0) return -1;
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const x = ap[i], y = bp[i];
    if (x === void 0) return -1;
    if (y === void 0) return 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) - Number(y);
    } else if (xn !== yn) {
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/runtime/src/embedder/instantiate.ts
function elementCodec(element, o) {
  return {
    element,
    where: o.where,
    toHost: (v) => element === null ? void 0 : toHost(v, element, o),
    fromHost: (v) => element === null ? null : fromHost(v, element, o)
  };
}
function artifactsFromEnvelope(envelopeJson, componentBytes) {
  const { wire, adapters } = loadEnvelope(envelopeJson);
  return {
    plan: wire,
    componentBytes,
    adapters
  };
}
async function resolveArtifacts(src) {
  if ("plan" in src) return src;
  const translator = src.translator instanceof Translator ? src.translator : await Translator.create(src.translator);
  const { plan, adapters } = translator.translate(src.componentBytes);
  return {
    plan,
    componentBytes: src.componentBytes,
    adapters
  };
}
async function instantiate(source, imports = {}, opts = {}) {
  const artifacts = await resolveArtifacts(source);
  const facade = new Facade(artifacts, imports);
  const handle = await instantiateComponent({
    plan: artifacts.plan,
    componentBytes: artifacts.componentBytes,
    adapters: artifacts.adapters,
    imports: facade.rawImports,
    jspi: opts.jspi,
    verifyHash: opts.verifyHash,
    // THE ordering fix: the facade converted this plan in its constructor and
    // wired its import wrappers against those very `ResourceTypeInfo` tokens.
    // Host imports fire DURING instantiation (a core module's `start`
    // function runs inside `runInitializers`), so the facade cannot wait for
    // the handle to learn its own types.
    loadedPlan: facade.loaded
  });
  facade.bind(handle);
  const instance = {
    exports: facade.buildExports(handle),
    handle,
    imports: facade.leaves
  };
  Object.defineProperty(instance, INTERNAL_HOST_REGISTRIES, {
    value: facade.hostRegistries,
    enumerable: false
  });
  return instance;
}
var INTERNAL_HOST_REGISTRIES = Symbol("deltic.embedder.hostRegistries");
var Facade = class {
  artifacts;
  leaves;
  rawImports;
  #resolver;
  #bindings;
  /** ResourceTypeInfo identity -> ResourceIndex (one index, many tokens). */
  #tokenIndex;
  /**
   * The converted plan — owned by the facade and handed to the executor, so
   * both sides share one set of per-instantiation resource identity tokens.
   * Available from construction, which is what makes import wrappers usable
   * for the whole of instantiation.
   */
  loaded;
  #bridge;
  /**
   * Releases for reps minted while lowering the CURRENT call's arguments.
   * Argument lowering is synchronous and uninterrupted (no `await` between
   * `#lowerScope = […]` and the reset), so a single slot is race-free even
   * with concurrent export calls in flight.
   */
  #lowerScope;
  /** ResourceIndex -> registry, for diagnostics (see INTERNAL_HOST_REGISTRIES). */
  hostRegistries;
  /** True once `buildExports` has run: guest resource classes then exist. */
  #exportsBuilt;
  constructor(artifacts, providers) {
    this.artifacts = artifacts;
    this.rawImports = {};
    this.#bindings = /* @__PURE__ */ new Map();
    this.#tokenIndex = /* @__PURE__ */ new Map();
    this.#lowerScope = null;
    this.hostRegistries = /* @__PURE__ */ new Map();
    this.#exportsBuilt = false;
    this.#pendingHostResources = [];
    this.#resolver = new ImportResolver(providers);
    this.loaded = loadPlan(artifacts.plan);
    artifacts.plan.resourceTables.forEach((table, i) => {
      if (table.kind !== "concrete") return;
      const token = this.loaded.resourceTokens[i];
      if (token !== void 0) this.#tokenIndex.set(token, table.resource);
    });
    this.leaves = requiredImports(this.loaded);
    const resourceLeaves = this.leaves.filter((l) => l.kind === "resource");
    if (resourceLeaves.length > 0 && (artifacts.plan.importedResources ?? []).length === 0) {
      throw new PlanError(`this component imports the resource type(s) ${resourceLeaves.map((l) => `'${l.leaf}'`).join(", ")}, but the plan carries no \`importedResources\` table, so they cannot be bound to a ResourceIndex (contracts/plan-format.md v0.2). Re-translate with a shim that emits it.`);
    }
    this.#bridge = this.#makeBridge();
    this.#buildRawImports();
    this.#bindHostResources();
  }
  // -- resource-type identity ------------------------------------------------
  /**
   * Consistency check after instantiation.
   *
   * The facade no longer *learns* anything here — it handed its own
   * `LoadedPlan` to the executor precisely so that nothing about types or
   * resource identity depends on instantiation having finished. All this does
   * is assert the executor did not silently re-load (which would give it a
   * second, disjoint set of `ResourceTypeInfo` tokens and make every
   * `own`/`borrow` unresolvable).
   */
  bind(handle) {
    if (handle.loadedPlan !== this.loaded) {
      throw new PlanError("the executor instantiated from a different LoadedPlan than the facade built its import wrappers from; resource identity tokens would not match");
    }
  }
  #indexOf(rt) {
    const i = this.#tokenIndex.get(rt);
    if (i === void 0) {
      throw new PlanError("resource type is not bound to any resource table in this plan");
    }
    return i;
  }
  #binding(rt) {
    const index = this.#indexOf(rt);
    let b = this.#bindings.get(index);
    if (b === void 0) {
      if (!this.#exportsBuilt) {
        throw new PlanError(`a guest-implemented resource (ResourceIndex ${index}) crossed the boundary before instantiation finished \u2014 a guest \`start\` function passed an own/borrow handle to a host import. Its class is assembled from the component's own lifted exports, which do not exist yet. Host-implemented resources are unaffected. If a real component needs this, the class must be built lazily from the plan's export table instead of the runtime's export surface.`);
      }
      b = {
        kind: "guest",
        name: `resource-${index}`
      };
      this.#bindings.set(index, b);
    }
    return b;
  }
  // deno-lint-ignore no-explicit-any
  #guestClass(b) {
    b.cls ??= buildGuestResourceClass({
      name: b.name,
      ctor: null,
      ctorParams: null,
      methods: [],
      statics: []
    }, {
      impl: null,
      dtor: null
    }, () => Promise.reject(new TypeError("no methods")), () => []);
    return b.cls;
  }
  /**
   * Bind host-implemented resource types to their `ResourceIndex`.
   *
   * Everything this needs is static wire data (`plan.importedResources`, whose
   * entries are back-references into `plan.imports`), so it runs at
   * construction — before instantiation, and therefore before a guest `start`
   * function can call an import that carries an `own`/`borrow` of one.
   * Imported resources occupy `ResourceIndex` 0..n-1 in `importedResources`
   * order (plan-format.md v0.1 amendment #2 / v0.2).
   */
  #bindHostResources() {
    const importedResources = this.artifacts.plan.importedResources ?? [];
    for (const p of this.#pendingHostResources) {
      const at = importedResources.findIndex((ir) => ir.import === p.importIndex);
      if (at < 0) continue;
      this.#bindings.set(at, {
        kind: "host",
        name: this.leaves[p.importIndex].leaf,
        registry: p.registry,
        cls: p.cls
      });
      this.hostRegistries.set(at, p.registry);
    }
  }
  // -- the value bridge ------------------------------------------------------
  #makeBridge() {
    const self = this;
    return {
      liftOwn(rep, t) {
        const b = self.#binding(t.rt);
        if (b.kind === "host") return b.registry.release(rep);
        return makeWrapper(self.#guestClass(b), rep, t.rt, true);
      },
      liftBorrow(rep, t, scope) {
        const b = self.#binding(t.rt);
        if (b.kind === "host") return b.registry.lookup(rep);
        const w = makeWrapper(self.#guestClass(b), rep, t.rt, false);
        scope.add(() => invalidateWrapper(w));
        return w;
      },
      lowerOwn(v, t) {
        const b = self.#binding(t.rt);
        if (b.kind === "host") return b.registry.repFor(v);
        return takeRep(v, true, `own<${b.name}>`);
      },
      lowerBorrow(v, t) {
        const b = self.#binding(t.rt);
        if (b.kind === "host") {
          const known = b.registry.hasInstance(v);
          const rep = b.registry.repFor(v);
          if (!known) {
            self.#lowerScope?.push(() => b.registry.releaseIfPresent(rep));
          }
          return rep;
        }
        return takeRep(v, false, `borrow<${b.name}>`);
      }
    };
  }
  #opts(where) {
    return {
      bridge: this.#bridge,
      where
    };
  }
  #funcType(index, what) {
    const loaded = this.loaded;
    if (index === void 0) throw new PlanError(`${what}: no type index`);
    const t = loaded.types[index];
    if (t === void 0 || t.kind !== "func") {
      throw new PlanError(`${what}: type ${index} is not a function type`);
    }
    return t.funcType;
  }
  // -- imports ---------------------------------------------------------------
  #buildRawImports() {
    this.leaves.forEach((leaf, importIndex) => {
      const provider = this.#provider(leaf);
      const target = leaf.path.length === 0 ? null : nest(this.rawImports, leaf.interfaceId, leaf.path.slice(0, -1));
      const value = this.#wrapLeaf(leaf, importIndex, provider);
      if (target === null) this.rawImports[leaf.interfaceId] = value;
      else target[leaf.path[leaf.path.length - 1]] = value;
    });
  }
  /** Resolve the container object a leaf's implementation is read from. */
  #provider(leaf) {
    const hit = this.#resolver.resolve(leaf.interfaceId) ?? (leaf.path.length === 0 ? this.#resolver.resolve(camelCase(leaf.interfaceId)) : void 0);
    if (hit === void 0) {
      throw new PlanError(`host import '${label(leaf)}' not provided (no key '${leaf.interfaceId}' in imports; registered: ${this.#resolver.keys().join(", ") || "<none>"})`);
    }
    let value = hit.value;
    for (const seg of leaf.path.slice(0, -1)) {
      if (value === null || typeof value !== "object") {
        throw new PlanError(`host import '${label(leaf)}': '${seg}' is not reachable (${describe2(value)})`);
      }
      value = value[seg];
    }
    return value;
  }
  #wrapLeaf(leaf, importIndex, provider) {
    if (leaf.kind === "resource") {
      return this.#wrapResourceType(leaf, importIndex, provider);
    }
    if (leaf.kind !== "func") {
      throw new PlanError(`host import '${label(leaf)}': unsupported import kind '${leaf.kind}'`);
    }
    const dispatch = this.#dispatcher(leaf, provider);
    let impl = null;
    const wrapper = (...raw) => {
      if (impl === null) {
        const ft = this.#funcType(this.artifacts.plan.imports[importIndex].type, `import '${label(leaf)}'`);
        impl = this.#wrapImportFn(leaf, ft, dispatch);
      }
      return impl(...raw);
    };
    return isSuspending(dispatch) ? suspending(wrapper) : wrapper;
  }
  /** A host-implemented resource type: register the class, own the mapping. */
  #wrapResourceType(leaf, importIndex, provider) {
    const cls = leaf.path.length === 0 ? provider : pick(provider, [], [
      pascalCase(leaf.leaf),
      leaf.leaf
    ]);
    if (cls === void 0) {
      throw new PlanError(`host import '${label(leaf)}': the component imports the resource type '${leaf.leaf}'; provide the implementing class as '${pascalCase(leaf.leaf)}'`);
    }
    const registry = new HostResourceRegistry(pascalCase(leaf.leaf));
    this.#pendingHostResources.push({
      importIndex,
      registry,
      cls
    });
    return hostResourceType({
      name: leaf.leaf,
      // The guest dropped its last own handle: run the destructor, which for
      // a host-implemented resource is `instance[Symbol.dispose]?.()`.
      dtor: (rep) => registry.dtor(rep)
    });
  }
  #pendingHostResources;
  /** The JS call a lifted import leaf dispatches to. */
  #dispatcher(leaf, provider) {
    const m = leaf.member;
    if (m.form === "plain") {
      const fn = leaf.path.length === 0 ? provider : pick(provider, [], [
        camelCase(m.name),
        m.name
      ]);
      if (typeof fn !== "function") {
        throw new PlanError(`host import '${label(leaf)}' missing or not a function (got ${describe2(fn)}); expected '${camelCase(m.name)}'`);
      }
      const receiver = leaf.path.length === 0 ? void 0 : provider;
      const dispatch = (args) => fn.apply(receiver, args);
      return isSuspending(fn) ? suspending(dispatch) : dispatch;
    }
    const clsName = pascalCase(m.resource);
    const cls = pick(provider, [], [
      clsName,
      m.resource
    ]);
    if (cls === void 0) {
      throw new PlanError(`host import '${label(leaf)}': no class '${clsName}' provided`);
    }
    switch (m.form) {
      case "constructor":
        return (args) => new cls(...args);
      case "method": {
        const protoFn = cls?.prototype?.[camelCase(m.member)];
        const dispatch = (args) => {
          const [self, ...rest] = args;
          const fn = self?.[camelCase(m.member)];
          if (typeof fn !== "function") {
            throw new Trap(`host import '${label(leaf)}': the ${clsName} instance has no method '${camelCase(m.member)}'`);
          }
          return fn.apply(self, rest);
        };
        return isSuspending(protoFn) ? suspending(dispatch) : dispatch;
      }
      case "static": {
        const fn = cls[camelCase(m.member)];
        if (typeof fn !== "function") {
          throw new PlanError(`host import '${label(leaf)}': ${clsName} has no static '${camelCase(m.member)}'`);
        }
        const dispatch = (args) => fn.apply(cls, args);
        return isSuspending(fn) ? suspending(dispatch) : dispatch;
      }
    }
  }
  /**
   * The raw (definitions.py-shaped) function the executor lowers, wrapping a
   * conventions-shaped host implementation.
   *
   * Error model (contract §"Error model"), the inversion of jco's convention:
   *   * a returned value is the ok side;
   *   * `throw new WitError(payload)` is the err side of a `result<T, E>`;
   *   * a `Trap` passes through unchanged;
   *   * **any other throw is a host bug and becomes a trap naming the import**
   *     — never a guest-visible err. This is what makes the consumers'
   *     defensive `platformCall`-style wrappers unnecessary by construction.
   */
  #wrapImportFn(leaf, ft, dispatch) {
    const where = `import '${label(leaf)}'`;
    const o = this.#opts(where);
    const resultType = ft.results.length === 0 ? null : ft.results[0];
    const isResult = resultType !== null && resultType.kind === "result";
    const ok = (v) => {
      if (resultType === null) return void 0;
      if (isResult) {
        const rt = resultType;
        return {
          ok: rt.ok === null ? null : fromHost(v, rt.ok, o)
        };
      }
      return fromHost(v, resultType, o);
    };
    const fail = (e) => {
      if (e instanceof Trap) throw e;
      if (e instanceof WitError && isResult) {
        const rt = resultType;
        return {
          error: rt.error === null ? null : fromHost(e.payload, rt.error, o)
        };
      }
      if (e instanceof WitError) {
        throw new Trap(`${where} threw a WitError, but its WIT type has no err side; only a fallible import may signal an error value`);
      }
      throw new Trap(`${where} threw ${describeThrow(e)}. An unbranded throw from a host import is a host bug and becomes a trap: signal a WIT error with \`throw new WitError(payload)\`.`);
    };
    return (...raw) => {
      const scope = new BorrowScope();
      const args = ft.params.map((p, i) => toHost(raw[i], p, o, scope));
      let out;
      try {
        out = dispatch(args);
      } catch (e) {
        scope.end();
        return fail(e);
      }
      if (isThenable(out)) {
        return out.then((v) => {
          scope.end();
          return ok(v);
        }, (e) => {
          scope.end();
          return fail(e);
        });
      }
      scope.end();
      return ok(out);
    };
  }
  // -- exports ---------------------------------------------------------------
  // deno-lint-ignore no-explicit-any
  buildExports(handle) {
    this.#exportsBuilt = true;
    const out = {};
    const worldLeaves = [];
    for (const exp of this.artifacts.plan.exports) {
      if (exp.kind === "instance") {
        out[exp.name] = this.#buildInterface(exp.name, exp.exports, handle.exports[exp.name]);
      } else {
        worldLeaves.push(exp);
      }
    }
    if (worldLeaves.length > 0) {
      Object.assign(out, this.#buildInterface("", worldLeaves, handle.exports));
    }
    return out;
  }
  // deno-lint-ignore no-explicit-any
  #buildInterface(id, exps, raw) {
    const obj = {};
    const claimed = /* @__PURE__ */ new Map();
    const claim = (js, leaf) => {
      const held = claimed.get(js);
      if (held !== void 0) {
        throw new NameCollisionError(`export '${id || "<world>"}': the leaves '${held}' and '${leaf}' both map to the JS name '${js}'. Rename one in the WIT; the conventions layer will not guess which one wins.`);
      }
      claimed.set(js, leaf);
      return js;
    };
    const specs = /* @__PURE__ */ new Map();
    const specRt = /* @__PURE__ */ new Map();
    const spec = (name) => {
      let s = specs.get(name);
      if (s === void 0) {
        s = {
          name,
          ctor: null,
          ctorParams: null,
          methods: [],
          statics: []
        };
        specs.set(name, s);
      }
      return s;
    };
    for (const exp of exps) {
      if (exp.kind === "type") {
        if (exp.type.kind === "resource") {
          const token = this.loaded.resourceTokens[exp.type.resource];
          if (token !== void 0 && this.#tokenIndex.has(token)) {
            const index = this.#tokenIndex.get(token);
            const held = this.#bindings.get(index);
            if (held === void 0) {
              this.#bindings.set(index, {
                kind: "guest",
                name: exp.name
              });
            } else if (held.kind === "guest") {
              held.name = exp.name;
            }
          }
        }
        continue;
      }
      if (exp.kind === "instance") {
        throw new PlanError(`export '${id || "<world>"}/${exp.name}': nested instance exports are not surfaced by the conventions layer (only one level of interface nesting exists in plan v2)`);
      }
      if (exp.kind !== "lifted-func") {
        throw new PlanError(`export '${id || "<world>"}/${exp.name}': unsupported export kind '${exp.kind}'`);
      }
      const fn = raw[exp.name];
      if (typeof fn !== "function") {
        throw new PlanError(`export '${id || "<world>"}/${exp.name}': the runtime produced no callable for this lifted function`);
      }
      const ft = this.#funcType(exp.type, `export '${id}/${exp.name}'`);
      const member = parseLeafName(exp.name);
      const where = id === "" ? exp.name : `${id}#${exp.name}`;
      switch (member.form) {
        case "plain":
          obj[claim(camelCase(member.name), member.name)] = this.#wrapExportFn(fn, ft, where);
          break;
        case "constructor": {
          const s = spec(member.resource);
          s.ctor = fn[CONSTRUCTOR_SYNC_ENTRY] ?? fn;
          s.ctorParams = ft.params;
          rtOf(ft.results[0], specRt, member.resource);
          break;
        }
        case "method": {
          spec(member.resource).methods.push({
            member: member.member,
            raw: fn,
            params: ft.params,
            results: ft.results
          });
          rtOf(ft.params[0], specRt, member.resource);
          break;
        }
        case "static": {
          spec(member.resource).statics.push({
            member: member.member,
            raw: fn,
            params: ft.params,
            results: ft.results
          });
          break;
        }
      }
    }
    for (const [name, s] of specs) {
      const rt = specRt.get(name);
      if (rt === void 0) {
        throw new PlanError(`export '${id}': resource '${name}' has leaves but no own/borrow type to identify it by`);
      }
      const cls = buildGuestResourceClass(s, rt, (fn, params2, results, where, args) => this.#wrapExportFn(fn, {
        params: params2,
        results
      }, where)(...args), (args, params2, where) => args.map((a, i) => fromHost(a, params2[i], this.#opts(where))));
      obj[claim(pascalCase(name), name)] = cls;
      const index = this.#tokenIndex.get(rt);
      if (index !== void 0) {
        this.#bindings.set(index, {
          kind: "guest",
          name,
          cls
        });
      }
    }
    return obj;
  }
  /**
   * Lower a call's arguments, collecting the releases for anything that was
   * allocated *for the duration of this call* (see `lowerBorrow`).
   *
   * The collection window is the synchronous argument-lowering phase only —
   * `#lowerScope` is set and cleared with no `await` in between — so a single
   * slot is correct even with concurrent export calls in flight.
   */
  #lowerParams(params2, args, o) {
    const scope = [];
    const outer = this.#lowerScope;
    this.#lowerScope = scope;
    let lowered;
    try {
      lowered = params2.map((p, i) => fromHost(args[i], p, o));
    } catch (e) {
      for (const r of scope) r();
      throw e;
    } finally {
      this.#lowerScope = outer;
    }
    let released = false;
    return {
      lowered,
      release: () => {
        if (released) return;
        released = true;
        for (const r of scope) r();
      }
    };
  }
  /**
   * Wrap one lifted export.
   *
   * Uniformly Promise-shaped (contract §"Functions and async"): a sync
   * completion resolves immediately, so there is one calling convention.
   * A `result<T, E>` in *function-result* position resolves `T` or rejects
   * `WitError<E>`; a result nested inside a value is plain `{tag, val}` data
   * and never throws.
   */
  #wrapExportFn(fn, ft, where) {
    const o = this.#opts(where);
    const resultType = ft.results.length === 0 ? null : ft.results[0];
    if (resultType !== null && resultType.kind === "future") {
      const element = resultType.element;
      return (...args) => {
        if (args.length !== ft.params.length) {
          throw new TypeError(`${where}: expected ${ft.params.length} argument(s), got ${args.length}`);
        }
        const { lowered, release } = this.#lowerParams(ft.params, args, o);
        let pending;
        try {
          pending = Promise.resolve(fn(...lowered));
        } catch (e) {
          release();
          throw e;
        }
        void pending.then(release, release);
        return Future.deferred(pending, elementCodec(element, o));
      };
    }
    return async (...args) => {
      if (args.length !== ft.params.length) {
        throw new TypeError(`${where}: expected ${ft.params.length} argument(s), got ${args.length}`);
      }
      const { lowered, release } = this.#lowerParams(ft.params, args, o);
      let raw;
      try {
        raw = await fn(...lowered);
      } finally {
        release();
      }
      if (resultType === null) return void 0;
      if (resultType.kind === "result") {
        const v = raw;
        if ("error" in v) {
          throw new WitError(resultType.error === null ? void 0 : toHost(v["error"], resultType.error, o));
        }
        return resultType.ok === null ? void 0 : toHost(v["ok"], resultType.ok, o);
      }
      return toHost(raw, resultType, o);
    };
  }
};
function rtOf(t, into, name) {
  if (t === void 0) return;
  if (t.kind === "own" || t.kind === "borrow") into.set(name, t.rt);
}
function label(leaf) {
  return leaf.path.length === 0 ? leaf.interfaceId : `${leaf.interfaceId}/${leaf.path.join("/")}`;
}
function nest(root, key, path) {
  let cur = root[key] ??= {};
  for (const seg of path) {
    cur = cur[seg] ??= {};
  }
  return cur;
}
function pick(container, path, names) {
  let v = container;
  for (const seg of path) {
    if (v === null || typeof v !== "object") return void 0;
    v = v[seg];
  }
  if (v === null || typeof v !== "object") {
    return names.length === 0 ? v : void 0;
  }
  for (const n of names) {
    const hit = v[n];
    if (hit !== void 0) return hit;
  }
  return void 0;
}
function isThenable(v) {
  return v !== null && typeof v === "object" && "then" in v && typeof v.then === "function";
}
function describeThrow(e) {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return describe2(e);
}

// ../iroh-relay-ws/host/sockets.ts
function applyDecs2203RFactory() {
  function createAddInitializerMethod(initializers, decoratorFinishedRef) {
    return function addInitializer(initializer) {
      assertNotFinished(decoratorFinishedRef, "addInitializer");
      assertCallable(initializer, "An initializer");
      initializers.push(initializer);
    };
  }
  function memberDec(dec2, name, desc, initializers, kind, isStatic, isPrivate, metadata, value) {
    var kindStr;
    switch (kind) {
      case 1:
        kindStr = "accessor";
        break;
      case 2:
        kindStr = "method";
        break;
      case 3:
        kindStr = "getter";
        break;
      case 4:
        kindStr = "setter";
        break;
      default:
        kindStr = "field";
    }
    var ctx2 = {
      kind: kindStr,
      name: isPrivate ? "#" + name : name,
      static: isStatic,
      private: isPrivate,
      metadata
    };
    var decoratorFinishedRef = {
      v: false
    };
    ctx2.addInitializer = createAddInitializerMethod(initializers, decoratorFinishedRef);
    var get, set;
    if (kind === 0) {
      if (isPrivate) {
        get = desc.get;
        set = desc.set;
      } else {
        get = function() {
          return this[name];
        };
        set = function(v) {
          this[name] = v;
        };
      }
    } else if (kind === 2) {
      get = function() {
        return desc.value;
      };
    } else {
      if (kind === 1 || kind === 3) {
        get = function() {
          return desc.get.call(this);
        };
      }
      if (kind === 1 || kind === 4) {
        set = function(v) {
          desc.set.call(this, v);
        };
      }
    }
    if (isPrivate) {
      ctx2.access = get && set ? {
        get,
        set
      } : get ? {
        get
      } : {
        set
      };
    } else {
      if (get) {
        var originalGet = get;
        get = function(target) {
          if (arguments.length === 0) target = this;
          return originalGet.call(target);
        };
      }
      if (set) {
        var originalSet = set;
        set = function(target, value2) {
          if (arguments.length === 1) {
            value2 = target;
            target = this;
          }
          return originalSet.call(target, value2);
        };
      }
      var has = function(target) {
        return name in target;
      };
      ctx2.access = get && set ? {
        has,
        get,
        set
      } : get ? {
        has,
        get
      } : {
        has,
        set
      };
    }
    try {
      return dec2(value, ctx2);
    } finally {
      decoratorFinishedRef.v = true;
    }
  }
  function assertNotFinished(decoratorFinishedRef, fnName) {
    if (decoratorFinishedRef.v) {
      throw new Error("attempted to call " + fnName + " after decoration was finished");
    }
  }
  function assertCallable(fn, hint) {
    if (typeof fn !== "function") {
      throw new TypeError(hint + " must be a function");
    }
  }
  function assertValidReturnValue(kind, value) {
    var type = typeof value;
    if (kind === 1) {
      if (type !== "object" || value === null) {
        throw new TypeError("accessor decorators must return an object with get, set, or init properties or void 0");
      }
      if (value.get !== void 0) {
        assertCallable(value.get, "accessor.get");
      }
      if (value.set !== void 0) {
        assertCallable(value.set, "accessor.set");
      }
      if (value.init !== void 0) {
        assertCallable(value.init, "accessor.init");
      }
    } else if (type !== "function") {
      var hint;
      if (kind === 0) {
        hint = "field";
      } else if (kind === 10) {
        hint = "class";
      } else {
        hint = "method";
      }
      throw new TypeError(hint + " decorators must return a function or void 0");
    }
  }
  function applyMemberDec(ret, base, decInfo, name, kind, isStatic, isPrivate, initializers, metadata) {
    var decs = decInfo[0];
    var desc, init, value;
    if (isPrivate) {
      if (kind === 0 || kind === 1) {
        desc = {
          get: decInfo[3],
          set: decInfo[4]
        };
      } else if (kind === 3) {
        desc = {
          get: decInfo[3]
        };
      } else if (kind === 4) {
        desc = {
          set: decInfo[3]
        };
      } else {
        desc = {
          value: decInfo[3]
        };
      }
    } else if (kind !== 0) {
      desc = Object.getOwnPropertyDescriptor(base, name);
    }
    if (kind === 1) {
      value = {
        get: desc.get,
        set: desc.set
      };
    } else if (kind === 2) {
      value = desc.value;
    } else if (kind === 3) {
      value = desc.get;
    } else if (kind === 4) {
      value = desc.set;
    }
    var newValue, get, set;
    if (typeof decs === "function") {
      newValue = memberDec(decs, name, desc, initializers, kind, isStatic, isPrivate, metadata, value);
      if (newValue !== void 0) {
        assertValidReturnValue(kind, newValue);
        if (kind === 0) {
          init = newValue;
        } else if (kind === 1) {
          init = newValue.init;
          get = newValue.get || value.get;
          set = newValue.set || value.set;
          value = {
            get,
            set
          };
        } else {
          value = newValue;
        }
      }
    } else {
      for (var i = decs.length - 1; i >= 0; i--) {
        var dec2 = decs[i];
        newValue = memberDec(dec2, name, desc, initializers, kind, isStatic, isPrivate, metadata, value);
        if (newValue !== void 0) {
          assertValidReturnValue(kind, newValue);
          var newInit;
          if (kind === 0) {
            newInit = newValue;
          } else if (kind === 1) {
            newInit = newValue.init;
            get = newValue.get || value.get;
            set = newValue.set || value.set;
            value = {
              get,
              set
            };
          } else {
            value = newValue;
          }
          if (newInit !== void 0) {
            if (init === void 0) {
              init = newInit;
            } else if (typeof init === "function") {
              init = [
                init,
                newInit
              ];
            } else {
              init.push(newInit);
            }
          }
        }
      }
    }
    if (kind === 0 || kind === 1) {
      if (init === void 0) {
        init = function(instance, init2) {
          return init2;
        };
      } else if (typeof init !== "function") {
        var ownInitializers = init;
        init = function(instance, init2) {
          var value2 = init2;
          for (var i2 = 0; i2 < ownInitializers.length; i2++) {
            value2 = ownInitializers[i2].call(instance, value2);
          }
          return value2;
        };
      } else {
        var originalInitializer = init;
        init = function(instance, init2) {
          return originalInitializer.call(instance, init2);
        };
      }
      ret.push(init);
    }
    if (kind !== 0) {
      if (kind === 1) {
        desc.get = value.get;
        desc.set = value.set;
      } else if (kind === 2) {
        desc.value = value;
      } else if (kind === 3) {
        desc.get = value;
      } else if (kind === 4) {
        desc.set = value;
      }
      if (isPrivate) {
        if (kind === 1) {
          ret.push(function(instance, args) {
            return value.get.call(instance, args);
          });
          ret.push(function(instance, args) {
            return value.set.call(instance, args);
          });
        } else if (kind === 2) {
          ret.push(value);
        } else {
          ret.push(function(instance, args) {
            return value.call(instance, args);
          });
        }
      } else {
        Object.defineProperty(base, name, desc);
      }
    }
  }
  function applyMemberDecs(Class, decInfos, metadata) {
    var ret = [];
    var protoInitializers;
    var staticInitializers;
    var existingProtoNonFields = /* @__PURE__ */ new Map();
    var existingStaticNonFields = /* @__PURE__ */ new Map();
    for (var i = 0; i < decInfos.length; i++) {
      var decInfo = decInfos[i];
      if (!Array.isArray(decInfo)) continue;
      var kind = decInfo[1];
      var name = decInfo[2];
      var isPrivate = decInfo.length > 3;
      var isStatic = kind >= 5;
      var base;
      var initializers;
      if (isStatic) {
        base = Class;
        kind = kind - 5;
        staticInitializers = staticInitializers || [];
        initializers = staticInitializers;
      } else {
        base = Class.prototype;
        protoInitializers = protoInitializers || [];
        initializers = protoInitializers;
      }
      if (kind !== 0 && !isPrivate) {
        var existingNonFields = isStatic ? existingStaticNonFields : existingProtoNonFields;
        var existingKind = existingNonFields.get(name) || 0;
        if (existingKind === true || existingKind === 3 && kind !== 4 || existingKind === 4 && kind !== 3) {
          throw new Error("Attempted to decorate a public method/accessor that has the same name as a previously decorated public method/accessor. This is not currently supported by the decorators plugin. Property name was: " + name);
        } else if (!existingKind && kind > 2) {
          existingNonFields.set(name, kind);
        } else {
          existingNonFields.set(name, true);
        }
      }
      applyMemberDec(ret, base, decInfo, name, kind, isStatic, isPrivate, initializers, metadata);
    }
    pushInitializers(ret, protoInitializers);
    pushInitializers(ret, staticInitializers);
    return ret;
  }
  function pushInitializers(ret, initializers) {
    if (initializers) {
      ret.push(function(instance) {
        for (var i = 0; i < initializers.length; i++) {
          initializers[i].call(instance);
        }
        return instance;
      });
    }
  }
  function applyClassDecs(targetClass, classDecs, metadata) {
    if (classDecs.length > 0) {
      var initializers = [];
      var newClass = targetClass;
      var name = targetClass.name;
      for (var i = classDecs.length - 1; i >= 0; i--) {
        var decoratorFinishedRef = {
          v: false
        };
        try {
          var nextNewClass = classDecs[i](newClass, {
            kind: "class",
            name,
            addInitializer: createAddInitializerMethod(initializers, decoratorFinishedRef),
            metadata
          });
        } finally {
          decoratorFinishedRef.v = true;
        }
        if (nextNewClass !== void 0) {
          assertValidReturnValue(10, nextNewClass);
          newClass = nextNewClass;
        }
      }
      return [
        defineMetadata(newClass, metadata),
        function() {
          for (var i2 = 0; i2 < initializers.length; i2++) {
            initializers[i2].call(newClass);
          }
        }
      ];
    }
  }
  function defineMetadata(Class, metadata) {
    return Object.defineProperty(Class, Symbol.metadata || Symbol.for("Symbol.metadata"), {
      configurable: true,
      enumerable: true,
      value: metadata
    });
  }
  return function applyDecs2203R(targetClass, memberDecs, classDecs, parentClass) {
    if (parentClass !== void 0) {
      var parentMetadata = parentClass[Symbol.metadata || Symbol.for("Symbol.metadata")];
    }
    var metadata = Object.create(parentMetadata === void 0 ? null : parentMetadata);
    var e = applyMemberDecs(targetClass, memberDecs, metadata);
    if (!classDecs.length) defineMetadata(targetClass, metadata);
    return {
      e,
      get c() {
        return applyClassDecs(targetClass, classDecs, metadata);
      }
    };
  };
}
function _apply_decs_2203_r(targetClass, memberDecs, classDecs, parentClass) {
  return (_apply_decs_2203_r = applyDecs2203RFactory())(targetClass, memberDecs, classDecs, parentClass);
}
var _initProto;
var _computedKey;
var _computedKey1;
var _computedKey2;
var _computedKey3;
var _computedKey4;
var _computedKey5;
var stats = {
  pollCalls: 0,
  pollSuspends: 0,
  blocks: 0,
  datagramsIn: 0,
  datagramsOut: 0
};
var hrnow = () => BigInt(Math.round(performance.now() * 1e6));
var Pollable = class {
  static {
    ({ e: [_initProto] } = _apply_decs_2203_r(this, [
      [
        suspending,
        2,
        "block"
      ]
    ], []));
  }
  #readyFn;
  #waitFn;
  constructor(readyFn, waitFn) {
    _initProto(this);
    this.#readyFn = readyFn;
    this.#waitFn = waitFn;
  }
  ready() {
    return this.#readyFn();
  }
  /** Sync WIT function that genuinely parks: tier (c), `@suspending`. */
  async block() {
    stats.blocks++;
    while (!this.#readyFn()) await this.#waitFn();
  }
  waitPromise() {
    return this.#waitFn();
  }
};
var ready = () => new Pollable(() => true, () => Promise.resolve());
var never = () => new Pollable(() => false, () => new Promise(() => {
}));
async function poll(list) {
  stats.pollCalls++;
  for (; ; ) {
    const ready2 = [];
    for (let i = 0; i < list.length; i++) {
      if (list[i].ready()) ready2.push(i);
    }
    if (ready2.length) return ready2;
    stats.pollSuspends++;
    await Promise.race(list.map((p) => p.waitPromise?.() ?? new Promise(() => {
    })));
  }
}
function timerPollable(deadlineNs) {
  return new Pollable(() => hrnow() >= deadlineNs, () => new Promise((r) => {
    const ms = Number(deadlineNs - hrnow()) / 1e6;
    setTimeout(r, Math.max(0, ms));
  }));
}
var monotonicClock = {
  now: hrnow,
  resolution: () => 1000n,
  subscribeInstant: (when) => timerPollable(when),
  subscribeDuration: (ns) => timerPollable(hrnow() + ns)
};
_computedKey = Symbol.dispose;
var Network = class {
  [_computedKey]() {
  }
};
var theNetwork = new Network();
var BRIDGE_ADDR = {
  tag: "ipv4",
  val: {
    port: 1,
    address: [
      127,
      0,
      0,
      1
    ]
  }
};
var nextEphemeralPort = 49152;
var bridges = /* @__PURE__ */ new Map();
function registerBridge(port, cb) {
  bridges.set(port, cb);
}
var addrRoutes = /* @__PURE__ */ new Map();
var addrKey = (remoteAddress) => `${remoteAddress.val.address.join(".")}:${remoteAddress.val.port}`;
function registerAddrRoute(address, port, cb) {
  addrRoutes.set(`${address.join(".")}:${port}`, cb);
}
var socketsByPort = /* @__PURE__ */ new Map();
function socketByLocalPort(port) {
  return socketsByPort.get(port);
}
function pushDatagram(socket, bytes, fromAddr = BRIDGE_ADDR) {
  stats.datagramsIn++;
  socket.queue.push({
    data: bytes,
    remoteAddress: fromAddr
  });
  socket.arrived();
}
_computedKey1 = Symbol.dispose;
var IncomingDatagramStream = class {
  #sock;
  constructor(sock) {
    this.#sock = sock;
  }
  receive(maxResults) {
    const q = this.#sock.queue;
    return q.splice(0, Math.min(Number(maxResults), q.length));
  }
  subscribe() {
    const sock = this.#sock;
    return new Pollable(() => sock.queue.length > 0, () => sock.arrivalPromise);
  }
  [_computedKey1]() {
  }
};
var unbridgedLogged = /* @__PURE__ */ new Set();
_computedKey2 = Symbol.dispose;
var OutgoingDatagramStream = class {
  #sock;
  constructor(sock) {
    this.#sock = sock;
  }
  checkSend() {
    return 64n;
  }
  send(datagrams) {
    for (const d of datagrams) {
      stats.datagramsOut++;
      const route = d.remoteAddress?.val ? addrRoutes.get(addrKey(d.remoteAddress)) : void 0;
      if (route) {
        route(this.#sock, d);
        continue;
      }
      const port = d.remoteAddress?.val?.port;
      const bridge = port === void 0 ? void 0 : bridges.get(port);
      if (bridge) {
        bridge(this.#sock, d);
      } else {
        const key = d.remoteAddress ? addrKey(d.remoteAddress) : String(port);
        if (!unbridgedLogged.has(key)) {
          unbridgedLogged.add(key);
          console.error(`[sockets] datagrams to unbridged ${key}; dropping (reported once)`);
        }
      }
    }
    return BigInt(datagrams.length);
  }
  subscribe() {
    return ready();
  }
  [_computedKey2]() {
  }
};
_computedKey3 = Symbol.dispose;
var UdpSocket = class {
  family;
  bound = false;
  localAddr = null;
  queue = [];
  arrivalPromise;
  arrived;
  /** Set by the overlay bridge: which registered endpoint sends from here. */
  overlayOwner;
  #pendingBind = null;
  constructor(family) {
    this.family = family;
    this.#rearm();
  }
  #rearm() {
    let resolve;
    this.arrivalPromise = new Promise((r) => resolve = r);
    this.arrived = () => {
      resolve();
      this.#rearm();
    };
  }
  startBind(_network, localAddress) {
    this.#pendingBind = localAddress;
  }
  finishBind() {
    if (this.#pendingBind === null) throw new WitError("not-in-progress");
    let addr = this.#pendingBind;
    this.#pendingBind = null;
    if (addr.val.port === 0) {
      addr = {
        tag: addr.tag,
        val: {
          ...addr.val,
          port: nextEphemeralPort++
        }
      };
    }
    this.localAddr = addr;
    this.bound = true;
    socketsByPort.set(addr.val.port, this);
  }
  stream(_remote) {
    return [
      new IncomingDatagramStream(this),
      new OutgoingDatagramStream(this)
    ];
  }
  localAddress() {
    if (!this.bound || this.localAddr === null) throw new WitError("invalid-state");
    return this.localAddr;
  }
  remoteAddress() {
    throw new WitError("invalid-state");
  }
  addressFamily() {
    return this.family;
  }
  unicastHopLimit() {
    return 64;
  }
  setUnicastHopLimit(_v) {
  }
  receiveBufferSize() {
    return 262144n;
  }
  setReceiveBufferSize(_v) {
  }
  sendBufferSize() {
    return 262144n;
  }
  setSendBufferSize(_v) {
  }
  subscribe() {
    return new Pollable(() => this.queue.length > 0, () => this.arrivalPromise);
  }
  [_computedKey3]() {
  }
};
var unsupported = () => {
  throw new WitError("not-supported");
};
_computedKey4 = Symbol.dispose;
var TcpSocket = class {
  startBind = unsupported;
  finishBind = unsupported;
  startConnect = unsupported;
  finishConnect = unsupported;
  startListen = unsupported;
  finishListen = unsupported;
  accept = unsupported;
  localAddress = unsupported;
  remoteAddress = unsupported;
  isListening() {
    return false;
  }
  addressFamily() {
    return "ipv4";
  }
  setListenBacklogSize = unsupported;
  keepAliveEnabled = unsupported;
  setKeepAliveEnabled = unsupported;
  keepAliveIdleTime = unsupported;
  setKeepAliveIdleTime = unsupported;
  keepAliveInterval = unsupported;
  setKeepAliveInterval = unsupported;
  keepAliveCount = unsupported;
  setKeepAliveCount = unsupported;
  hopLimit = unsupported;
  setHopLimit = unsupported;
  receiveBufferSize = unsupported;
  setReceiveBufferSize = unsupported;
  sendBufferSize = unsupported;
  setSendBufferSize = unsupported;
  shutdown = unsupported;
  subscribe() {
    return never();
  }
  [_computedKey4]() {
  }
};
_computedKey5 = Symbol.dispose;
var ResolveAddressStream = class {
  resolveNextAddress() {
    throw new WitError("permanent-resolver-failure");
  }
  subscribe() {
    return ready();
  }
  [_computedKey5]() {
  }
};
function syntheticNetImports() {
  return {
    "wasi:io/poll@0.2": {
      Pollable,
      poll: suspending(poll)
    },
    "wasi:clocks/monotonic-clock@0.2": monotonicClock,
    "wasi:sockets/network@0.2": {
      Network
    },
    "wasi:sockets/instance-network@0.2": {
      instanceNetwork: () => theNetwork
    },
    "wasi:sockets/udp@0.2": {
      UdpSocket,
      IncomingDatagramStream,
      OutgoingDatagramStream
    },
    "wasi:sockets/udp-create-socket@0.2": {
      createUdpSocket: (family) => new UdpSocket(family)
    },
    "wasi:sockets/tcp@0.2": {
      TcpSocket
    },
    "wasi:sockets/tcp-create-socket@0.2": {
      createTcpSocket: unsupported
    },
    "wasi:sockets/ip-name-lookup@0.2": {
      ResolveAddressStream,
      resolveAddresses: () => {
        throw new WitError("permanent-resolver-failure");
      }
    }
  };
}

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/wasi-shims/src/io.ts
function closedError() {
  return new WitError({
    tag: "closed"
  });
}
var IoError = class {
  #message;
  constructor(message = "I/O error") {
    this.#message = message;
  }
  toDebugString() {
    return this.#message;
  }
};
var Pollable2 = class {
  ready() {
    return true;
  }
  /** Tier (a) no-op — see class doc. Never parks. */
  block() {
  }
};
function poll2(pollables) {
  return pollables.map((_p, i) => i);
}
var InputStream = class {
  #buf;
  #pos = 0;
  #closed = false;
  constructor(buf = new Uint8Array(0)) {
    this.#buf = buf;
  }
  read(len) {
    if (this.#closed) throw closedError();
    const n = Math.max(0, Math.min(Number(len), this.#buf.length - this.#pos));
    const out = this.#buf.slice(this.#pos, this.#pos + n);
    this.#pos += n;
    return out;
  }
  /** Tier (b): the buffer is always immediately available; blocking degenerates to `read`. */
  blockingRead(len) {
    return this.read(len);
  }
  skip(len) {
    return BigInt(this.read(len).length);
  }
  blockingSkip(len) {
    return this.skip(len);
  }
  subscribe() {
    return new Pollable2();
  }
  [Symbol.dispose]() {
    this.#closed = true;
  }
};
var OutputStream = class {
  #sink;
  #closed = false;
  constructor(sink) {
    this.#sink = sink;
  }
  checkWrite() {
    if (this.#closed) throw closedError();
    return 65536n;
  }
  write(contents) {
    if (this.#closed) throw closedError();
    this.#sink(contents);
  }
  blockingWriteAndFlush(contents) {
    this.write(contents);
  }
  flush() {
    if (this.#closed) throw closedError();
  }
  blockingFlush() {
    this.flush();
  }
  subscribe() {
    return new Pollable2();
  }
  writeZeroes(len) {
    this.write(new Uint8Array(Number(len)));
  }
  blockingWriteZeroesAndFlush(len) {
    this.writeZeroes(len);
  }
  splice(src, len) {
    const chunk = src.read(len);
    this.write(chunk);
    return BigInt(chunk.length);
  }
  blockingSplice(src, len) {
    return this.splice(src, len);
  }
  [Symbol.dispose]() {
    this.#closed = true;
  }
};
function io() {
  return {
    imports: {
      "wasi:io/error@0.2": {
        Error: IoError
      },
      "wasi:io/poll@0.2": {
        Pollable: Pollable2,
        poll: poll2
      },
      "wasi:io/streams@0.2": {
        InputStream,
        OutputStream
      }
    }
  };
}

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/wasi-shims/src/cli.ts
var ExitError = class extends Error {
  ok;
  constructor(ok) {
    super(`wasi:cli/exit#exit(${ok ? "success" : "failure"})`), this.ok = ok;
    this.name = "ExitError";
  }
};
var TerminalInput = class {
};
var TerminalOutput = class {
};
function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
function cli(options = {}) {
  const stdoutChunks = [];
  const stderrChunks = [];
  const passthrough = options.passthrough ?? false;
  let exited = false;
  let exitOk;
  const stdout = new OutputStream((chunk) => {
    stdoutChunks.push(chunk);
    if (passthrough) console.log(new TextDecoder().decode(chunk));
  });
  const stderr = new OutputStream((chunk) => {
    stderrChunks.push(chunk);
    if (passthrough) console.error(new TextDecoder().decode(chunk));
  });
  const captured = {
    stdout: () => concat(stdoutChunks),
    stderr: () => concat(stderrChunks),
    stdoutText: () => new TextDecoder().decode(concat(stdoutChunks)),
    stderrText: () => new TextDecoder().decode(concat(stderrChunks)),
    exited: () => exited,
    exitOk: () => exitOk
  };
  const imports = {
    "wasi:cli/environment@0.2": {
      getEnvironment: () => Object.entries(options.env ?? {}),
      getArguments: () => options.args ?? [],
      initialCwd: () => options.cwd
    },
    "wasi:cli/exit@0.2": {
      exit: (status) => {
        exited = true;
        exitOk = status.tag === "ok";
        if (options.throwOnExit) throw new ExitError(exitOk);
      }
    },
    "wasi:cli/stdin@0.2": {
      getStdin: () => new InputStream(options.stdinBuffer)
    },
    "wasi:cli/stdout@0.2": {
      getStdout: () => stdout
    },
    "wasi:cli/stderr@0.2": {
      getStderr: () => stderr
    },
    "wasi:cli/terminal-input@0.2": {
      TerminalInput
    },
    "wasi:cli/terminal-output@0.2": {
      TerminalOutput
    },
    // No terminal is ever attached; `option<terminal-*>` collapses to the
    // outermost-option rule (contract §"Value mapping"): `undefined` = none.
    "wasi:cli/terminal-stdin@0.2": {
      getTerminalStdin: () => void 0
    },
    "wasi:cli/terminal-stdout@0.2": {
      getTerminalStdout: () => void 0
    },
    "wasi:cli/terminal-stderr@0.2": {
      getTerminalStderr: () => void 0
    }
  };
  return {
    imports,
    captured
  };
}

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/wasi-shims/src/clocks.ts
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
function clocks(options = {}) {
  const nowFn = options.now ?? (() => BigInt(Math.round(performance.now() * 1e6)));
  const RESOLUTION_NS = 1000n;
  const monotonic02 = {
    now: nowFn,
    resolution: () => RESOLUTION_NS,
    subscribeInstant: (_when) => new Pollable2(),
    subscribeDuration: (_when) => new Pollable2()
  };
  const wallClock02 = {
    now: () => {
      const ms = Date.now();
      return {
        seconds: BigInt(Math.floor(ms / 1e3)),
        nanoseconds: ms % 1e3 * 1e6
      };
    },
    resolution: () => ({
      seconds: 0n,
      nanoseconds: 1e6
    })
  };
  const monotonic03 = {
    now: nowFn,
    getResolution: () => RESOLUTION_NS,
    waitUntil: async (when) => {
      const deltaNs = when - nowFn();
      await sleep(Number(deltaNs) / 1e6);
    },
    waitFor: async (howLong) => {
      await sleep(Number(howLong) / 1e6);
    }
  };
  return {
    imports: {
      "wasi:clocks/monotonic-clock@0.2": monotonic02,
      "wasi:clocks/wall-clock@0.2": wallClock02,
      "wasi:clocks/monotonic-clock@0.3": monotonic03
    }
  };
}

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/wasi-shims/src/filesystem.ts
var Descriptor = class {
  constructor() {
    throw new TypeError("wasi:filesystem/types.descriptor is never constructed by this shim (preopens#get-directories always returns [] \u2014 CONTRACT: contracts/embedder-api.md 'WASI examination' filesystem scope calls the type 'constructible-never')");
  }
  #unreachable(method) {
    throw new TypeError(`wasi:filesystem/types#[method]descriptor.${method}: unreachable \u2014 no descriptor instance can exist (preopens is empty)`);
  }
  getFlags() {
    return this.#unreachable("get-flags");
  }
  getType() {
    return this.#unreachable("get-type");
  }
  stat() {
    return this.#unreachable("stat");
  }
  statAt() {
    return this.#unreachable("stat-at");
  }
  openAt() {
    return this.#unreachable("open-at");
  }
  readViaStream() {
    return this.#unreachable("read-via-stream");
  }
  writeViaStream() {
    return this.#unreachable("write-via-stream");
  }
  appendViaStream() {
    return this.#unreachable("append-via-stream");
  }
  metadataHashAt() {
    return this.#unreachable("metadata-hash-at");
  }
};
var DirectoryEntryStream = class {
};
function filesystem() {
  return {
    imports: {
      "wasi:filesystem/types@0.2": {
        Descriptor,
        DirectoryEntryStream,
        // `filesystem-error-code: func(err: borrow<error>) -> option<error-code>`
        // — this shim's `wasi:io/error` never produces a filesystem-specific
        // error, so downcasting always fails (`none` -> `undefined`).
        filesystemErrorCode: (_err) => void 0
      },
      "wasi:filesystem/preopens@0.2": {
        // No preopened directories: consumer guests that never touch the
        // filesystem (the corpus under test) link this leaf but never call
        // a descriptor method.
        getDirectories: () => []
      }
    }
  };
}

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/wasi-shims/src/random.ts
var GET_RANDOM_VALUES_MAX = 65536;
function randomBytes(len) {
  const out = new Uint8Array(Number(len));
  for (let i = 0; i < out.length; i += GET_RANDOM_VALUES_MAX) {
    crypto.getRandomValues(out.subarray(i, Math.min(i + GET_RANDOM_VALUES_MAX, out.length)));
  }
  return out;
}
function randomU64() {
  const out = new Uint8Array(8);
  crypto.getRandomValues(out);
  return new DataView(out.buffer).getBigUint64(0, true);
}
var DEFAULT_INSECURE_SEED = [
  0n,
  1n
];
function random(options = {}) {
  const seed2 = options.insecureSeed ?? DEFAULT_INSECURE_SEED;
  return {
    imports: {
      "wasi:random/random@0.2": {
        getRandomBytes: randomBytes,
        getRandomU64: randomU64
      },
      // "insecure" only means "not required to be a CSPRNG" — it is still
      // wired to the real CSPRNG here for simplicity; only `insecure-seed`
      // is deliberately, documentedly predictable.
      "wasi:random/insecure@0.2": {
        getInsecureRandomBytes: randomBytes,
        getInsecureRandomU64: randomU64
      },
      "wasi:random/insecure-seed@0.2": {
        insecureSeed: () => seed2
      }
    }
  };
}

// deno:https://raw.githubusercontent.com/lann/deltic/pre-eb3f8d0/wasi-shims/src/mod.ts
function wasiShims(options = {}) {
  const c = cli(options.cli);
  const merged = {
    ...c.imports,
    ...io().imports,
    ...clocks(options.clocks).imports,
    ...random(options.random).imports,
    ...filesystem().imports
  };
  return Object.assign(merged, {
    captured: c.captured
  });
}

// ../iroh-relay-ws/host/harness.ts
function artifactsFrom(envelopeJson, componentBytes) {
  return artifactsFromEnvelope(envelopeJson, componentBytes);
}
function lineSink(tag, emit) {
  let buf = "";
  const decoder2 = new TextDecoder();
  return (chunk) => {
    buf += decoder2.decode(chunk, {
      stream: true
    });
    for (; ; ) {
      const nl = buf.indexOf("\n");
      if (nl === -1) break;
      emit(`[${tag}] ${buf.slice(0, nl)}`);
      buf = buf.slice(nl + 1);
    }
  };
}
function guestImports(options) {
  const stdout = new OutputStream(lineSink("guest-out", console.log));
  const stderr = new OutputStream(lineSink("guest-err", console.error));
  return {
    ...wasiShims({
      cli: {
        args: options.args,
        env: options.env
      }
    }),
    ...syntheticNetImports(),
    "wasi:cli/stdout@0.2": {
      getStdout: () => stdout
    },
    "wasi:cli/stderr@0.2": {
      getStderr: () => stderr
    }
  };
}
async function runGuest(artifacts, imports) {
  const instance = await instantiate(artifacts, imports);
  const runKey = Object.keys(instance.exports).find((k) => k.startsWith("wasi:cli/run@"));
  if (runKey === void 0) {
    throw new Error(`guest exports no wasi:cli/run interface (exports: ${Object.keys(instance.exports).join(", ")})`);
  }
  await instance.exports[runKey].run();
}

// ../../.deps/websocket/js/deltic/websocket.ts
function witError(payload) {
  return new WitError(payload, payload.tag + ("val" in payload ? `: ${payload.val}` : ""));
}
var DEFAULT_CONNECT_TIMEOUT_MS = 3e4;
var DEFAULT_CLOSE_TIMEOUT_MS = 1e4;
var DEFAULT_MAX_INBOUND_BUFFERED = 8 * 1024 * 1024;
var MAX_BUFFERED_AMOUNT = 8 * 1024 * 1024;
var DRAIN_POLL_MS = 4;
var READ_BATCH = 65536;
var maxInboundBuffered = DEFAULT_MAX_INBOUND_BUFFERED;
var connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS;
var closeTimeoutMs = DEFAULT_CLOSE_TIMEOUT_MS;
var utf8 = new TextEncoder();
function utf8ByteLength(text) {
  return utf8.encode(text).byteLength;
}
function isValidProtocolToken(token) {
  if (!token.length) return false;
  for (let i = 0; i < token.length; i += 1) {
    const c = token.charCodeAt(i);
    if (c <= 32 || c >= 127) return false;
    if ('"(),/:;<=>?@[\\]{}'.includes(token[i])) return false;
  }
  return true;
}
function validateUrl(url) {
  if (url.includes("#")) {
    throw witError({
      tag: "invalid-url",
      val: "URL must not have a fragment"
    });
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw witError({
      tag: "invalid-url",
      val: `URL does not parse: ${err?.message ?? err}`
    });
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw witError({
      tag: "invalid-url",
      val: `URL scheme must be ws or wss, not ${JSON.stringify(parsed.protocol)}`
    });
  }
  if (!parsed.hostname) {
    throw witError({
      tag: "invalid-url",
      val: "URL must have a host"
    });
  }
  if (parsed.username || parsed.password) {
    throw witError({
      tag: "invalid-url",
      val: "URL must not have userinfo"
    });
  }
}
function validateProtocols(protocols) {
  for (let i = 0; i < protocols.length; i += 1) {
    const protocol = protocols[i];
    if (!isValidProtocolToken(protocol)) {
      throw witError({
        tag: "invalid-argument",
        val: `subprotocol ${JSON.stringify(protocol)} is not a valid token`
      });
    }
    if (protocols.indexOf(protocol) !== i) {
      throw witError({
        tag: "invalid-argument",
        val: `subprotocol ${JSON.stringify(protocol)} is offered twice`
      });
    }
  }
}
function validateCloseArgs(code, reason) {
  if (code !== void 0 && code !== null) {
    if (code !== 1e3 && !(code >= 3e3 && code <= 4999)) {
      throw witError({
        tag: "invalid-argument",
        val: `close code must be 1000 or in 3000-4999, not ${code}`
      });
    }
  } else if (reason.length) {
    throw witError({
      tag: "invalid-argument",
      val: "a close reason requires a close code"
    });
  }
  const bytes = utf8ByteLength(reason);
  if (bytes > 123) {
    throw witError({
      tag: "invalid-argument",
      val: `close reason must be at most 123 bytes, got ${bytes}`
    });
  }
}
var SYNTHESIZED_CLOSE_CODES = /* @__PURE__ */ new Set([
  0,
  1006,
  1015
]);
var Websocket = class _Websocket {
  #ws;
  #incoming;
  /** Set by a local `close()` (or dispose): the close is observed locally
   *  at once and the unread backlog is discarded. */
  #localClosed = false;
  /** Set once `receive-via-stream` has claimed the inbound messages. */
  #streamClaimed = false;
  /** Whether `wait-closed` has settled. */
  #closeSettled = false;
  #closeInfo = void 0;
  #closeWaiters = [];
  #closeDeadline = null;
  /**
   * `connect: static async func(url, protocols) -> result<websocket, error>`.
   * Resolves with a `Websocket` once the handshake completes; throws
   * `WitError<WebsocketError>` on failure. websocket.js:203.
   */
  static async connect(url, protocols) {
    validateUrl(url);
    validateProtocols(protocols);
    let ws;
    try {
      ws = protocols.length ? new WebSocket(url, protocols) : new WebSocket(url);
    } catch (err) {
      throw witError({
        tag: "connect-failed",
        val: String(err?.message ?? err)
      });
    }
    ws.binaryType = "arraybuffer";
    await new Promise((resolve, reject) => {
      let timer;
      const settle = (fn, value) => {
        clearTimeout(timer);
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("close", onClose);
        ws.removeEventListener("error", onError);
        fn(value);
      };
      const onOpen = () => settle(resolve);
      const onClose = (event) => {
        const ce = event;
        settle(reject, witError({
          tag: "connect-failed",
          val: ce.reason || `connection failed (code ${ce.code})`
        }));
      };
      const onError = () => {
      };
      ws.addEventListener("open", onOpen, {
        once: true
      });
      ws.addEventListener("close", onClose, {
        once: true
      });
      ws.addEventListener("error", onError, {
        once: true
      });
      timer = setTimeout(() => {
        settle(reject, witError({
          tag: "connect-failed",
          val: `handshake timed out after ${connectTimeoutMs}ms`
        }));
        try {
          ws.close();
        } catch {
        }
      }, connectTimeoutMs);
    });
    if (protocols.length && !protocols.includes(ws.protocol)) {
      try {
        ws.close();
      } catch {
      }
      throw witError({
        tag: "connect-failed",
        val: ws.protocol ? `server selected subprotocol ${JSON.stringify(ws.protocol)} which was not offered` : "server selected no subprotocol although one was offered"
      });
    }
    if (!protocols.length && ws.protocol) {
      try {
        ws.close();
      } catch {
      }
      throw witError({
        tag: "connect-failed",
        val: `server selected subprotocol ${JSON.stringify(ws.protocol)} although none was offered`
      });
    }
    return new _Websocket(ws);
  }
  /** @param ws an OPEN `WebSocket` */
  constructor(ws) {
    this.#ws = ws;
    this.#incoming = incomingQueue(ws, () => this.#transportClosing());
    ws.addEventListener("close", (event) => this.#settleClosed(event), {
      once: true
    });
    ws.addEventListener("error", () => {
    }, {
      once: true
    });
  }
  /** `protocol: func() -> string` — the negotiated subprotocol, or "". */
  protocol() {
    return this.#ws.protocol;
  }
  /**
   * `send: async func(message) -> result<_, error>`. Resolves once the
   * message is handed to the transport; throws `closed` once a close was
   * initiated (locally or by the peer) — messages are never silently
   * discarded. websocket.js:305.
   */
  async send(message) {
    for (; ; ) {
      if (this.#localClosed || this.#ws.readyState !== WebSocket.OPEN) {
        throw witError({
          tag: "closed"
        });
      }
      if (this.#ws.bufferedAmount <= MAX_BUFFERED_AMOUNT) break;
      await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
    }
    try {
      this.#ws.send(message.val);
    } catch (err) {
      throw witError({
        tag: "other",
        val: String(err?.message ?? err)
      });
    }
  }
  /**
   * `receive: async func() -> result<message, error>`. Throws the WIT
   * `error` once the connection closes. websocket.js:325.
   */
  receive() {
    if (this.#localClosed) return Promise.reject(witError({
      tag: "closed"
    }));
    if (this.#streamClaimed) {
      return Promise.reject(witError({
        tag: "receiving-via-stream"
      }));
    }
    return this.#incoming.next();
  }
  /**
   * `send-via-stream: async func(stream<stream-message>) -> result<_, send-via-stream-error>`.
   * Throws `WitError<SendViaStreamError>`. websocket.js:336.
   */
  async sendViaStream(messages) {
    let sent = 0n;
    try {
      for await (const item of streamItems(messages)) {
        const { bytes, excess } = await collectByteStream(item.data, item.length);
        if (excess > 0 || bytes.length !== item.length) {
          throw witError({
            tag: "other",
            val: `stream-message payload was ${bytes.length + excess} bytes but length declared ${item.length}`
          });
        }
        let message;
        if (item.kind === "string") {
          let text;
          try {
            text = new TextDecoder("utf-8", {
              fatal: true
            }).decode(bytes);
          } catch {
            throw witError({
              tag: "other",
              val: "string stream-message payload is not valid UTF-8"
            });
          }
          message = {
            tag: "string",
            val: text
          };
        } else {
          message = {
            tag: "binary",
            val: bytes
          };
        }
        await this.send(message);
        sent += 1n;
      }
    } catch (error) {
      const payload = error instanceof WitError ? error.payload : {
        tag: "other",
        val: String(error)
      };
      throw new WitError({
        error: payload,
        sent
      }, `send-via-stream failed after ${sent} message(s)`);
    }
  }
  /**
   * `receive-via-stream: func() -> result<stream<stream-message>, error>`.
   * Once-only: a second call (or any later `receive`) throws
   * `receiving-via-stream`, and any pending `receive` is rejected with it.
   * The stream ends when the connection closes. websocket.js:388.
   *
   * Returns a `ReadableStream`, one of the natural JS producers the
   * conventions accept where a `stream<T>` is expected
   * (contracts/embedder-api.md §"Streams and futures").
   */
  receiveViaStream() {
    if (this.#localClosed) throw witError({
      tag: "closed"
    });
    if (this.#streamClaimed) throw witError({
      tag: "receiving-via-stream"
    });
    this.#streamClaimed = true;
    const incoming = this.#incoming;
    incoming.rejectWaiters({
      tag: "receiving-via-stream"
    });
    return new ReadableStream({
      async pull(controller) {
        let message;
        try {
          message = await incoming.next();
        } catch {
          controller.close();
          return;
        }
        const bytes = message.tag === "string" ? new TextEncoder().encode(message.val) : message.val;
        controller.enqueue({
          kind: message.tag,
          length: bytes.length,
          data: bytesToStream(bytes)
        });
      }
    });
  }
  /** `state: func() -> websocket-state`. `closed` is terminal and latched. */
  state() {
    return this.#currentState();
  }
  /**
   * `wait-closed: async func() -> option<close-info>`. Latched: every call
   * resolves with the same value. `option` in the outermost position maps
   * to `T | undefined` (contracts/embedder-api.md §"Value mapping").
   */
  waitClosed() {
    if (this.#closeSettled) return Promise.resolve(this.#closeInfo);
    return new Promise((resolve) => this.#closeWaiters.push(resolve));
  }
  /**
   * `close: func(code: option<u16>, reason: string) -> result<_, error>` —
   * deliberately synchronous. Validate eagerly, then initiate the closing
   * handshake and return. Idempotent after the first accepted call.
   * websocket.js:441.
   */
  close(code, reason) {
    validateCloseArgs(code, reason);
    if (this.#localClosed) return;
    this.#localClosed = true;
    this.#incoming.discard();
    this.#closeDeadline = setTimeout(() => this.#settleClosed(null), closeTimeoutMs);
    try {
      if (code === void 0 || code === null) {
        this.#ws.close();
      } else if (reason.length) {
        this.#ws.close(code, reason);
      } else {
        this.#ws.close(code);
      }
    } catch {
    }
  }
  /**
   * The dtor the runtime invokes when the guest drops its last own handle
   * (contracts/embedder-api.md §"Resources"): dropping without `close`
   * implies `close(none, "")`, per the WIT contract.
   */
  [Symbol.dispose]() {
    try {
      this.close(void 0, "");
    } catch {
    }
  }
  /**
   * A close was initiated below the resource (an inbound-buffer overflow):
   * bound the teardown. Unlike a guest-initiated `close`, the receivable
   * backlog is kept — overflow readers drain it before observing the
   * overflow error. websocket.js:483.
   */
  #transportClosing() {
    if (!this.#closeSettled && this.#closeDeadline === null) {
      this.#closeDeadline = setTimeout(() => this.#settleClosed(null), closeTimeoutMs);
    }
  }
  #currentState() {
    if (this.#closeSettled) return "closed";
    if (this.#localClosed) return "closing";
    switch (this.#ws.readyState) {
      case WebSocket.CLOSING:
        return "closing";
      case WebSocket.CLOSED:
        return "closed";
      default:
        return "open";
    }
  }
  /**
   * Settle the close outcome. `event` is the `CloseEvent`, or `null` when
   * the close bound expired first. Codes 1006 (abnormal) and 1015 (TLS
   * failure) are synthesized by the platform, never carried by a frame, so
   * they map to "no close-info", per the WIT close contract
   * (wit/websocket.wit:106-118: "A `close-info` exists only when the peer
   * actually sent a close frame ... and implementations never invent one").
   * websocket.js:508.
   *
   * DENO DELTA (the one behavioral divergence from the reference host).
   * On an abnormal closure — the peer drops TCP with no close frame —
   * browsers and Node deliver `CloseEvent.code === 1006`, but **Deno
   * delivers `0`** (verified empirically against the suite's own
   * `/abrupt-close` endpoint: `{code: 0, reason: "", wasClean: false}`,
   * versus `{code: 4001, wasClean: true}` for a real close frame on the
   * same runtime). Code 0 is not a wire value at all — no frame carried
   * it — so it belongs in exactly the same bucket as 1006. Without this,
   * `websocket/close/abnormal` and `websocket/tls/abrupt-close` fail with
   * "abnormal closure produced close-info code=0".
   *
   * 1005 is deliberately NOT in the set: it is the legitimate observation
   * of a close frame that carried no code (wit/websocket.wit:113-115), and
   * the suite asserts `close-info{code: 1005}` for it
   * (`close/local-default`, `close/remote-no-code`).
   */
  #settleClosed(event) {
    if (this.#closeSettled) return;
    this.#closeSettled = true;
    if (this.#closeDeadline !== null) {
      clearTimeout(this.#closeDeadline);
      this.#closeDeadline = null;
    }
    this.#incoming.end();
    if (event && !SYNTHESIZED_CLOSE_CODES.has(event.code)) {
      this.#closeInfo = {
        code: event.code,
        reason: event.reason ?? ""
      };
    } else {
      this.#closeInfo = void 0;
    }
    const waiters = this.#closeWaiters;
    this.#closeWaiters = [];
    for (const resolve of waiters) resolve(this.#closeInfo);
  }
};
function incomingQueue(ws, onOverflowClose) {
  const limit = maxInboundBuffered;
  const messages = [];
  const waiters = [];
  let buffered = 0;
  let overflowed = false;
  let closed = false;
  const push = (message, size) => {
    const waiter = waiters.shift();
    if (waiter) {
      waiter.resolve(message);
    } else {
      buffered += size;
      messages.push({
        message,
        size
      });
    }
  };
  ws.addEventListener("message", (event) => {
    const data = event.data;
    if (overflowed) return;
    const size = typeof data === "string" ? utf8ByteLength(data) : data.byteLength;
    if (buffered + size > limit) {
      overflowed = true;
      try {
        ws.close();
      } catch {
      }
      onOverflowClose();
      return;
    }
    const message = typeof data === "string" ? {
      tag: "string",
      val: data
    } : {
      tag: "binary",
      val: new Uint8Array(data)
    };
    push(message, size);
  });
  const endError = () => overflowed ? {
    tag: "receive-buffer-overflow"
  } : {
    tag: "closed"
  };
  const end = () => {
    if (closed) return;
    closed = true;
    while (waiters.length) {
      waiters.shift().reject(witError(endError()));
    }
  };
  ws.addEventListener("close", end);
  ws.addEventListener("error", end);
  return {
    next() {
      if (messages.length) {
        const { message, size } = messages.shift();
        buffered -= size;
        return Promise.resolve(message);
      }
      if (overflowed) {
        return Promise.reject(witError({
          tag: "receive-buffer-overflow"
        }));
      }
      if (closed) return Promise.reject(witError({
        tag: "closed"
      }));
      return new Promise((resolve, reject) => waiters.push({
        resolve,
        reject
      }));
    },
    rejectWaiters(error) {
      while (waiters.length) {
        waiters.shift().reject(witError(error));
      }
    },
    end,
    /** Discard the unread backlog and fail pending and future reads
     *  `closed` (a local `close`, per the WIT contract). */
    discard() {
      messages.length = 0;
      buffered = 0;
      closed = true;
      while (waiters.length) {
        waiters.shift().reject(witError({
          tag: "closed"
        }));
      }
    }
  };
}
async function* streamItems(stream) {
  if (typeof ReadableStream !== "undefined" && stream instanceof ReadableStream) {
    const reader = stream.getReader();
    try {
      for (; ; ) {
        const { value, done } = await reader.read();
        if (done) break;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
    return;
  }
  for await (const value of stream) {
    if (Array.isArray(value)) {
      yield* value;
    } else {
      yield value;
    }
  }
}
function toByteChunk(value) {
  if (typeof value === "number") return Uint8Array.of(value);
  if (value instanceof Uint8Array) return value;
  return Uint8Array.from(value);
}
function bytesToStream(bytes) {
  return new ReadableStream({
    start(controller) {
      if (bytes.length) controller.enqueue(bytes);
      controller.close();
    }
  });
}
async function collectByteStream(stream, limit) {
  const chunks = [];
  let total = 0;
  let excess = 0;
  const push = (value) => {
    if (value === void 0 || value === null) return;
    let chunk = toByteChunk(value);
    if (!chunk.length) return;
    const room = limit - total;
    if (chunk.length > room) {
      excess += chunk.length - Math.max(room, 0);
      if (room <= 0) return;
      chunk = chunk.subarray(0, room);
    }
    chunks.push(chunk);
    total += chunk.length;
  };
  if (typeof ReadableStream !== "undefined" && stream instanceof ReadableStream) {
    const reader = stream.getReader();
    try {
      for (; ; ) {
        const { value, done } = await reader.read();
        if (done) break;
        push(value);
      }
    } finally {
      reader.releaseLock();
    }
  } else if (stream instanceof Stream) {
    for (; ; ) {
      const chunk = await stream.read(READ_BATCH);
      if (chunk.length === 0) break;
      push(chunk);
    }
  } else {
    for await (const value of stream) {
      push(value);
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return {
    bytes: out,
    excess
  };
}

// ../iroh-relay-ws/host/errors.ts
function describeErr(err) {
  if (err instanceof WitError) {
    const p = err.payload;
    if (p !== void 0 && typeof p === "object" && "tag" in p) {
      return `${p.tag}${p.val === void 0 ? "" : `(${String(p.val)})`}`;
    }
    return `WitError(${String(p)})`;
  }
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

// ../iroh-relay-ws/host/bridge.ts
var TAG_CONTROL = 0;
var TAG_MESSAGE = 1;
var TAG_CLOSED = 2;
var enc = new TextEncoder();
var dec = new TextDecoder();
var bridgeStats = {
  connections: 0,
  wsIn: 0,
  wsOut: 0
};
var conns = /* @__PURE__ */ new Map();
function frame(tag, bytes) {
  const out = new Uint8Array(bytes.length + 1);
  out[0] = tag;
  out.set(bytes, 1);
  return out;
}
async function open(socket, url, protocols) {
  try {
    const ws = await Websocket.connect(url, protocols);
    conns.set(socket, {
      ws,
      sendChain: Promise.resolve()
    });
    bridgeStats.connections++;
    console.log(`[bridge] ws open ${url} proto=${ws.protocol()}`);
    pushDatagram(socket, frame(TAG_CONTROL, enc.encode(ws.protocol())));
    for (; ; ) {
      let message;
      try {
        message = await ws.receive();
      } catch (err) {
        console.log(`[bridge] ws closed: ${describeErr(err)}`);
        pushDatagram(socket, new Uint8Array([
          TAG_CLOSED
        ]));
        conns.delete(socket);
        return;
      }
      bridgeStats.wsIn++;
      const bytes = message.tag === "binary" ? message.val : enc.encode(message.val);
      pushDatagram(socket, frame(TAG_MESSAGE, bytes));
    }
  } catch (err) {
    console.error(`[bridge] ws connect failed: ${describeErr(err)}`);
    pushDatagram(socket, new Uint8Array([
      TAG_CLOSED
    ]));
  }
}
registerBridge(1, (socket, { data }) => {
  if (data.length === 0) return;
  const tag = data[0];
  const payload = data.subarray(1);
  switch (tag) {
    case TAG_CONTROL: {
      const text = dec.decode(payload);
      const nl = text.indexOf("\n");
      const url = text.slice(0, nl);
      const protocols = text.slice(nl + 1).split(",").filter(Boolean);
      void open(socket, url, protocols);
      break;
    }
    case TAG_MESSAGE: {
      const conn = conns.get(socket);
      if (!conn) {
        console.error("[bridge] message before websocket open; dropping");
        return;
      }
      bridgeStats.wsOut++;
      const bytes = payload.slice();
      conn.sendChain = conn.sendChain.then(() => conn.ws.send({
        tag: "binary",
        val: bytes
      })).catch((err) => {
        console.error(`[bridge] ws send failed: ${describeErr(err)}`);
        pushDatagram(socket, new Uint8Array([
          TAG_CLOSED
        ]));
      });
      break;
    }
    default:
      console.error(`[bridge] unknown tag ${tag}`);
  }
});

// ../../.deps/webrtc/deltic-impl/src/webrtc.ts
var offerNeedsChannel = false;
var cachedRTCPeerConnection;
async function resolveRTCPeerConnection() {
  if (cachedRTCPeerConnection) return cachedRTCPeerConnection;
  const g = globalThis;
  if (g.RTCPeerConnection) {
    cachedRTCPeerConnection = g.RTCPeerConnection;
    return cachedRTCPeerConnection;
  }
  try {
    const { RTCPeerConnection } = await import("node-datachannel/polyfill");
    offerNeedsChannel = true;
    cachedRTCPeerConnection = RTCPeerConnection;
    return cachedRTCPeerConnection;
  } catch (cause) {
    throw new Error("no RTCPeerConnection available: not running in a browser and node-datachannel could not be loaded (run `deno install --allow-scripts=npm:node-datachannel` in deltic-impl)", {
      cause
    });
  }
}
var MAX_BUFFERED_AMOUNT2 = 8 * 1024 * 1024;
var CONNECT_TIMEOUT_MS = 2e4;
var CLOSE_DRAIN_MS = 1e3;
var DEFAULT_MAX_INBOUND_BUFFERED2 = 8 * 1024 * 1024;
var maxInboundBuffered2 = DEFAULT_MAX_INBOUND_BUFFERED2;
var utf82 = new TextEncoder();
function utf8ByteLength2(text) {
  return utf82.encode(text).byteLength;
}
var DataChannelOptions = class {
  #label = "";
  #ordered = true;
  #maxRetransmits = void 0;
  label() {
    return this.#label;
  }
  setLabel(label2) {
    this.#label = label2;
  }
  ordered() {
    return this.#ordered;
  }
  setOrdered(ordered) {
    this.#ordered = ordered;
  }
  maxRetransmits() {
    return this.#maxRetransmits;
  }
  setMaxRetransmits(maxRetransmits) {
    this.#maxRetransmits = maxRetransmits;
  }
  /** The `RTCDataChannelInit` these options describe. */
  toInit() {
    const init = {
      ordered: this.#ordered
    };
    if (this.#maxRetransmits != null) {
      init.maxRetransmits = this.#maxRetransmits;
    }
    return init;
  }
};
var PeerConnectionConfig = class {
  #iceServers = [];
  #policy = "all";
  iceServers() {
    return this.#iceServers;
  }
  setIceServers(servers) {
    for (const server of servers) {
      if (!server.urls.length) {
        throw new WitError({
          tag: "invalid",
          val: "ice-server has no urls"
        });
      }
      for (const url of server.urls) {
        if (!/^(stun|stuns|turn|turns):/.test(url)) {
          throw new WitError({
            tag: "invalid",
            val: `ice-server url ${JSON.stringify(url)} has no stun:/stuns:/turn:/turns: scheme`
          });
        }
      }
    }
    this.#iceServers = servers;
  }
  iceTransportPolicy() {
    return this.#policy;
  }
  setIceTransportPolicy(policy) {
    this.#policy = policy;
  }
  /** The `RTCConfiguration` these options describe. */
  toConfiguration() {
    const configuration = {
      iceTransportPolicy: this.#policy
    };
    if (this.#iceServers.length) {
      configuration.iceServers = this.#iceServers.map((server) => {
        const entry = {
          urls: server.urls
        };
        if (server.username) entry.username = server.username;
        if (server.credential) entry.credential = server.credential;
        return entry;
      });
    }
    return configuration;
  }
};
function incomingQueue2(channel) {
  const limit = maxInboundBuffered2;
  const messages = [];
  const waiters = [];
  let buffered = 0;
  let overflowed = false;
  let closed = false;
  const push = (message, size) => {
    const waiter = waiters.shift();
    if (waiter) {
      waiter.resolve(message);
    } else {
      buffered += size;
      messages.push({
        message,
        size
      });
    }
  };
  channel.addEventListener("message", ({ data }) => {
    if (overflowed) return;
    const size = typeof data === "string" ? utf8ByteLength2(data) : data.byteLength;
    if (buffered + size > limit && !waiters.length) {
      overflowed = true;
      channel.close();
      return;
    }
    const message = typeof data === "string" ? {
      tag: "string",
      val: data
    } : {
      tag: "binary",
      val: new Uint8Array(data)
    };
    push(message, size);
  });
  const endError = () => overflowed ? {
    tag: "receive-buffer-overflow"
  } : {
    tag: "closed"
  };
  const end = () => {
    if (closed) return;
    closed = true;
    while (waiters.length) waiters.shift().reject(endError());
  };
  channel.addEventListener("close", end);
  channel.addEventListener("error", end);
  return {
    next() {
      if (messages.length) {
        const { message, size } = messages.shift();
        buffered -= size;
        return Promise.resolve(message);
      }
      if (overflowed) return Promise.reject(new WitError({
        tag: "receive-buffer-overflow"
      }));
      if (closed) return Promise.reject(new WitError({
        tag: "closed"
      }));
      return new Promise((resolve, reject) => {
        waiters.push({
          resolve,
          reject: (e) => reject(new WitError(e))
        });
      });
    },
    /** Reject every pending waiter with a raw `error` payload (not wrapped). */
    rejectWaiters(error) {
      while (waiters.length) waiters.shift().reject(error);
    },
    /** Discard the unread backlog; fail pending and future reads `closed`. */
    discard() {
      messages.length = 0;
      buffered = 0;
      closed = true;
      while (waiters.length) waiters.shift().reject({
        tag: "closed"
      });
    }
  };
}
var DataChannel = class {
  // deno-lint-ignore no-explicit-any
  #channel;
  #incoming;
  #streamClaimed = false;
  #localClosed = false;
  #stateTaken = false;
  #statePokes = /* @__PURE__ */ new Set();
  // deno-lint-ignore no-explicit-any
  constructor(channel) {
    this.#channel = channel;
    channel.binaryType = "arraybuffer";
    this.#incoming = incomingQueue2(channel);
  }
  label() {
    return this.#channel.label;
  }
  async send(message) {
    if (this.#localClosed) throw new WitError({
      tag: "closed"
    });
    await this.#waitOpen();
    await this.#waitForDrain();
    try {
      this.#channel.send(message.val);
    } catch {
      throw new WitError({
        tag: "closed"
      });
    }
  }
  async receive() {
    if (this.#localClosed) throw new WitError({
      tag: "closed"
    });
    if (this.#streamClaimed) {
      throw new WitError({
        tag: "receiving-via-stream"
      });
    }
    return this.#incoming.next();
  }
  /**
   * Send a stream of messages whose payloads are each streamed as bytes.
   * The conventions hand the host a `Stream<T>` handle for a guest-provided
   * `stream<T>` parameter; a plain `ReadableStream`/`AsyncIterable` is also
   * tolerated (contracts/embedder-api.md §"Streams and futures").
   */
  async sendViaStream(messages) {
    let sent = 0n;
    try {
      for await (const item of streamItems2(messages)) {
        const bytes = await collectByteStream2(item.data);
        if (bytes.length !== item.length) {
          throw {
            tag: "other",
            val: `stream-message payload was ${bytes.length} bytes but length declared ${item.length}`
          };
        }
        const message = item.kind === "string" ? {
          tag: "string",
          val: new TextDecoder().decode(bytes)
        } : {
          tag: "binary",
          val: bytes
        };
        await this.send(message);
        sent += 1n;
      }
    } catch (error) {
      const payload = error instanceof WitError ? error.payload : isWebrtcError(error) ? error : {
        tag: "closed"
      };
      throw new WitError({
        error: payload,
        sent
      });
    }
  }
  /**
   * Take over the channel's inbound messages, delivering each as a
   * `StreamMessage` whose payload is a `StreamSource<u8>`. Once-only per
   * the WIT contract. Returns a plain `ReadableStream`, one of the natural
   * JS producers the conventions accept where a `stream<T>` result is
   * expected — the runtime lowers it; this port never drives a `Store`.
   */
  receiveViaStream() {
    if (this.#localClosed) throw new WitError({
      tag: "closed"
    });
    if (this.#streamClaimed) {
      throw new WitError({
        tag: "receiving-via-stream"
      });
    }
    this.#streamClaimed = true;
    const incoming = this.#incoming;
    incoming.rejectWaiters({
      tag: "receiving-via-stream"
    });
    return new ReadableStream({
      async pull(controller) {
        let message;
        try {
          message = await incoming.next();
        } catch {
          controller.close();
          return;
        }
        const bytes = message.tag === "string" ? new TextEncoder().encode(message.val) : message.val;
        controller.enqueue({
          kind: message.tag,
          length: bytes.length,
          data: bytesToReadable(bytes)
        });
      }
    });
  }
  /** Resolve once the channel is open, or reject `closed` if it closes. */
  #waitOpen() {
    const channel = this.#channel;
    if (channel.readyState === "open") return Promise.resolve();
    if (channel.readyState === "closing" || channel.readyState === "closed") {
      return Promise.reject(new WitError({
        tag: "closed"
      }));
    }
    return new Promise((resolve, reject) => {
      channel.addEventListener("open", () => resolve(), {
        once: true
      });
      channel.addEventListener("close", () => reject(new WitError({
        tag: "closed"
      })), {
        once: true
      });
      channel.addEventListener("error", () => reject(new WitError({
        tag: "closed"
      })), {
        once: true
      });
    });
  }
  close() {
    if (this.#localClosed) return;
    this.#localClosed = true;
    this.#incoming.discard();
    try {
      this.#channel.close();
    } catch {
    }
    for (const poke of this.#statePokes) poke();
  }
  stateChanges() {
    if (this.#stateTaken) {
      return new ReadableStream({
        start(c) {
          c.close();
        }
      });
    }
    this.#stateTaken = true;
    return stateStream(() => this.#channel.readyState, (wake) => {
      for (const event of [
        "open",
        "closing",
        "close",
        "error"
      ]) {
        this.#channel.addEventListener(event, wake);
      }
      this.#statePokes.add(wake);
    }, (state) => state === "closed");
  }
  [Symbol.dispose]() {
    try {
      this.close();
    } catch {
    }
  }
  /** Apply backpressure so a fast producer cannot overrun the SCTP buffer. */
  #waitForDrain() {
    const channel = this.#channel;
    if (channel.bufferedAmount <= MAX_BUFFERED_AMOUNT2) return Promise.resolve();
    return new Promise((resolve) => {
      channel.bufferedAmountLowThreshold = MAX_BUFFERED_AMOUNT2 / 2;
      const onLow = () => {
        channel.removeEventListener("bufferedamountlow", onLow);
        resolve();
      };
      channel.addEventListener("bufferedamountlow", onLow);
    });
  }
};
function isWebrtcError(v) {
  return typeof v === "object" && v !== null && typeof v.tag === "string";
}
var PeerConnection = class _PeerConnection {
  // deno-lint-ignore no-explicit-any
  #pc;
  #candidates;
  #channels;
  #everConnected = false;
  #closed = false;
  #failed = false;
  #candidatesTaken = false;
  #channelsTaken = false;
  #closeHooks = /* @__PURE__ */ new Set();
  // deno-lint-ignore no-explicit-any
  #ownedChannels = /* @__PURE__ */ new Set();
  /**
   * The `DataChannel` wrappers over `#ownedChannels`, latched closed by
   * `close()`: the wrapper's local-close flag is the synchronous gate the
   * WIT contract's "observed locally at once" requires, because a backend
   * may transition the native `readyState` asynchronously (node-datachannel
   * does — see `DataChannel.send`'s gate comment).
   */
  #ownedWrappers = /* @__PURE__ */ new Set();
  #stateTaken = false;
  #statePokes = /* @__PURE__ */ new Set();
  /**
   * Construct a peer connection. `config` is taken by ownership, matching
   * the WIT constructor `constructor(config: option<peer-connection-config>)`
   * (contracts/embedder-api.md: "the WIT constructor as the JS constructor",
   * and — "Constructors are synchronous" — this cannot await).
   *
   * CONTRACT: resolving `RTCPeerConnection` isomorphically is necessarily
   * async (the node-datachannel polyfill is a dynamic `import`). This module
   * resolves the backend once via a **top-level await**
   * (`resolveRTCPeerConnection()` at the bottom of this file, mirroring the
   * reference's own top-level await, jco-impl/webrtc.js:45): ES module
   * evaluation does not complete — so no importer's code can run — until a
   * module's own top-level await settles, which means every consumer that
   * imports this file only ever observes it after the backend is already
   * cached. `new PeerConnection(config)` therefore stays synchronous, as the
   * WIT constructor requires. `create()` remains available as an async
   * convenience for test code that deliberately re-resolves the backend
   * mid-run (`resetResolvedBackend()`/`useWerift()`).
   */
  constructor(config) {
    if (!cachedRTCPeerConnection) {
      throw new Error("PeerConnection constructed before the RTCPeerConnection backend resolved \u2014 this should be unreachable via normal module import (top-level await); if resolution failed, the actionable error was already thrown/logged at module load. Use `await PeerConnection.create(config)` after `resetResolvedBackend()`.");
    }
    const ctor = cachedRTCPeerConnection;
    this.#pc = new ctor(config ? config.toConfiguration() : void 0);
    const latch = () => {
      if (this.#isConnectedNow()) this.#everConnected = true;
      if (!this.#failed && this.#isFailedNow()) {
        this.#failed = true;
        for (const hook of this.#closeHooks) hook();
        this.#closeHooks.clear();
        this.#candidates.end();
        this.#channels.end();
        for (const poke of this.#statePokes) poke();
      }
    };
    this.#pc.addEventListener("connectionstatechange", latch);
    this.#pc.addEventListener("iceconnectionstatechange", latch);
    this.#candidates = eventStream((push, end) => {
      const seen = /* @__PURE__ */ new Set();
      const pushCandidate = (candidate, sdpMid, sdpMlineIndex) => {
        const normalized = candidate.trim().replace(/^a=/, "");
        if (seen.has(normalized)) return;
        seen.add(normalized);
        push({
          candidate: normalized,
          sdpMid,
          sdpMlineIndex
        });
      };
      this.#pc.addEventListener("icecandidate", ({ candidate }) => {
        if (candidate == null || candidate.candidate === "") {
          end();
          return;
        }
        pushCandidate(candidate.candidate, candidate.sdpMid ?? void 0, candidate.sdpMLineIndex ?? void 0);
      });
      this.#pc.addEventListener("icegatheringstatechange", () => {
        if (this.#pc.iceGatheringState !== "complete") return;
        for (const c of sdpCandidates(this.#pc.localDescription?.sdp)) {
          pushCandidate(c.candidate, c.sdpMid, c.sdpMlineIndex);
        }
        end();
      });
    });
    this.#channels = eventStream((push) => {
      this.#pc.addEventListener("datachannel", ({ channel }) => {
        this.#ownedChannels.add(channel);
        const wrapper = new DataChannel(channel);
        this.#ownedWrappers.add(wrapper);
        push(wrapper);
      });
    });
  }
  /**
   * Async convenience factory: resolve the backend (if not already cached)
   * then construct. Equivalent to `new PeerConnection(config)` once the
   * top-level await above has settled; useful for test code that calls
   * `resetResolvedBackend()`/`useWerift()` mid-run.
   */
  static async create(config) {
    await resolveRTCPeerConnection();
    return new _PeerConnection(config);
  }
  #requireOpen() {
    if (this.#closed || this.#failed || this.#isFailedNow() || this.#pc.connectionState === "closed") {
      throw new WitError({
        tag: "closed"
      });
    }
  }
  #isConnectedNow() {
    return this.#pc.connectionState === "connected" || this.#pc.iceConnectionState === "connected" || this.#pc.iceConnectionState === "completed";
  }
  #isFailedNow() {
    return this.#pc.connectionState === "failed" || this.#pc.iceConnectionState === "failed";
  }
  createDataChannel(options) {
    this.#requireOpen();
    try {
      const channel = this.#pc.createDataChannel(options.label(), options.toInit());
      this.#ownedChannels.add(channel);
      const wrapper = new DataChannel(channel);
      this.#ownedWrappers.add(wrapper);
      return wrapper;
    } catch (err) {
      throw new WitError({
        tag: "other",
        val: String(err)
      });
    }
  }
  incomingDataChannels() {
    if (this.#channelsTaken) {
      return new ReadableStream({
        start(c) {
          c.close();
        }
      });
    }
    this.#channelsTaken = true;
    return this.#channels.stream;
  }
  async createOffer() {
    this.#requireOpen();
    try {
      if (offerNeedsChannel && this.#ownedChannels.size === 0) {
        this.#pc.createDataChannel("", {
          negotiated: true,
          id: 1023
        });
      }
      const offer = await this.#pc.createOffer();
      return {
        kind: "offer",
        sdp: offer.sdp
      };
    } catch (err) {
      throw new WitError({
        tag: "other",
        val: String(err)
      });
    }
  }
  async createAnswer() {
    this.#requireOpen();
    try {
      const answer = await this.#pc.createAnswer();
      return {
        kind: "answer",
        sdp: answer.sdp
      };
    } catch (err) {
      throw new WitError({
        tag: "other",
        val: String(err)
      });
    }
  }
  async setLocalDescription(description) {
    this.#requireOpen();
    try {
      await this.#pc.setLocalDescription({
        type: description.kind,
        sdp: description.sdp
      });
    } catch (err) {
      throw new WitError({
        tag: "invalid-signaling",
        val: String(err)
      });
    }
  }
  async setRemoteDescription(description) {
    this.#requireOpen();
    try {
      await this.#pc.setRemoteDescription({
        type: description.kind,
        sdp: description.sdp
      });
    } catch (err) {
      throw new WitError({
        tag: "invalid-signaling",
        val: String(err)
      });
    }
  }
  localIceCandidates() {
    if (this.#candidatesTaken) {
      return new ReadableStream({
        start(c) {
          c.close();
        }
      });
    }
    this.#candidatesTaken = true;
    return this.#candidates.stream;
  }
  async addIceCandidate(candidate) {
    this.#requireOpen();
    try {
      await this.#pc.addIceCandidate({
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid ?? null,
        sdpMLineIndex: candidate.sdpMlineIndex ?? null
      });
    } catch (err) {
      throw new WitError({
        tag: "invalid-signaling",
        val: String(err)
      });
    }
  }
  stateChanges() {
    if (this.#stateTaken) {
      return new ReadableStream({
        start(c) {
          c.close();
        }
      });
    }
    this.#stateTaken = true;
    return stateStream(() => {
      if (this.#closed) return "closed";
      if (this.#failed) return "failed";
      return this.#pc.connectionState;
    }, (wake) => {
      this.#pc.addEventListener("connectionstatechange", wake);
      this.#pc.addEventListener("iceconnectionstatechange", wake);
      this.#statePokes.add(wake);
    }, (state) => state === "failed" || state === "closed");
  }
  async waitConnected() {
    const pc = this.#pc;
    const isFailed = () => this.#isFailedNow() || pc.connectionState === "closed";
    if (this.#isConnectedNow()) this.#everConnected = true;
    if (this.#everConnected) return;
    if (this.#closed || isFailed()) throw new WitError({
      tag: "closed"
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new WitError({
          tag: "timed-out"
        }));
      }, CONNECT_TIMEOUT_MS);
      const check = () => {
        if (this.#isConnectedNow()) {
          this.#everConnected = true;
          cleanup();
          resolve();
        } else if (isFailed()) {
          cleanup();
          reject(new WitError({
            tag: "closed"
          }));
        }
      };
      const onClose = () => {
        cleanup();
        reject(new WitError({
          tag: "closed"
        }));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.#closeHooks.delete(onClose);
        pc.removeEventListener("connectionstatechange", check);
        pc.removeEventListener("iceconnectionstatechange", check);
      };
      this.#closeHooks.add(onClose);
      pc.addEventListener("connectionstatechange", check);
      pc.addEventListener("iceconnectionstatechange", check);
    });
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const hook of this.#closeHooks) hook();
    this.#closeHooks.clear();
    this.#candidates.end();
    this.#channels.end();
    for (const poke of this.#statePokes) poke();
    for (const wrapper of this.#ownedWrappers) {
      try {
        wrapper.close();
      } catch {
      }
    }
    const deadline = Date.now() + CLOSE_DRAIN_MS;
    const drained = () => [
      ...this.#ownedChannels
    ].every((channel) => channel.bufferedAmount === 0);
    const tick = setInterval(() => {
      if (drained() || Date.now() >= deadline) {
        clearInterval(tick);
        this.#pc.close();
      }
    }, 10);
    tick.unref?.();
  }
  [Symbol.dispose]() {
    try {
      this.close();
    } catch {
    }
  }
};
function sdpCandidates(sdp) {
  if (!sdp) return [];
  const out = [];
  let sdpMid;
  let sdpMlineIndex = -1;
  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith("m=")) {
      sdpMlineIndex += 1;
      sdpMid = void 0;
    } else if (line.startsWith("a=mid:")) {
      sdpMid = line.slice("a=mid:".length).trim();
    } else if (line.startsWith("a=candidate:")) {
      out.push({
        candidate: line.slice("a=".length).trim(),
        sdpMid,
        sdpMlineIndex: sdpMlineIndex >= 0 ? sdpMlineIndex : void 0
      });
    }
  }
  return out;
}
async function* streamItems2(input) {
  if (input instanceof ReadableStream) {
    const reader = input.getReader();
    try {
      for (; ; ) {
        const { value, done } = await reader.read();
        if (done) break;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
    return;
  }
  for await (const value of input) {
    if (Array.isArray(value)) {
      yield* value;
    } else {
      yield value;
    }
  }
}
async function collectByteStream2(stream) {
  const chunks = [];
  let total = 0;
  const push = (value) => {
    if (value === void 0 || value === null) return;
    const chunk = toByteChunk2(value);
    if (chunk.length) {
      chunks.push(chunk);
      total += chunk.length;
    }
  };
  if (typeof ReadableStream !== "undefined" && stream instanceof ReadableStream) {
    const reader = stream.getReader();
    try {
      for (; ; ) {
        const { value, done } = await reader.read();
        if (done) break;
        push(value);
      }
    } finally {
      reader.releaseLock();
    }
  } else if (stream instanceof Stream) {
    const READ_BATCH2 = 65536;
    for (; ; ) {
      const chunk = await stream.read(READ_BATCH2);
      if (chunk.length === 0) break;
      push(chunk);
    }
  } else {
    for await (const value of stream) {
      push(value);
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
function toByteChunk2(value) {
  if (typeof value === "number") return Uint8Array.of(value);
  if (value instanceof Uint8Array) return value;
  return Uint8Array.from(value);
}
function bytesToReadable(bytes) {
  return new ReadableStream({
    start(controller) {
      if (bytes.length) controller.enqueue(bytes);
      controller.close();
    }
  });
}
function eventStream(setup) {
  let controller;
  let ended = false;
  const buffer = [];
  const stream = new ReadableStream({
    start(c) {
      controller = c;
      for (const item of buffer) c.enqueue(item);
      buffer.length = 0;
      if (ended) c.close();
    }
  });
  const push = (item) => {
    if (ended) return;
    if (controller) controller.enqueue(item);
    else buffer.push(item);
  };
  const end = () => {
    if (ended) return;
    ended = true;
    if (controller) {
      try {
        controller.close();
      } catch {
      }
    }
  };
  setup(push, end);
  return {
    stream,
    end
  };
}
function stateStream(current, subscribe, isTerminal) {
  let delivered;
  let hasDelivered = false;
  let notify = null;
  subscribe(() => {
    if (notify) {
      const wake = notify;
      notify = null;
      wake();
    }
  });
  return new ReadableStream({
    async pull(controller) {
      for (; ; ) {
        const woken = new Promise((resolve) => {
          notify = resolve;
        });
        const state = current();
        if (!hasDelivered || state !== delivered) {
          hasDelivered = true;
          delivered = state;
          controller.enqueue(state);
          if (isTerminal(state)) controller.close();
          return;
        }
        if (isTerminal(state)) {
          controller.close();
          return;
        }
        await woken;
      }
    }
  });
}
await resolveRTCPeerConnection().catch(() => {
  cachedRTCPeerConnection = void 0;
});

// web/overlay.ts
var CONTROL_FROM = {
  tag: "ipv4",
  val: {
    port: 2,
    address: [
      127,
      0,
      0,
      1
    ]
  }
};
var TAG_REGISTER = 0;
var TAG_ASSIGNED = 1;
var TAG_READY = 2;
var ID_LEN = 32;
var SYN_PORT = 4433;
var STUN = [
  {
    urls: [
      "stun:stun.l.google.com:19302"
    ],
    username: "",
    credential: ""
  }
];
var overlayStats = {
  in: 0,
  out: 0,
  droppedWhileConnecting: 0
};
var hexToBytes = (hex) => Uint8Array.from(hex.match(/.{2}/g), (b) => parseInt(b, 16));
function synAddr(idHex) {
  const b = hexToBytes(idHex.slice(0, 6));
  return {
    address: [
      100,
      64 | b[0] & 63,
      b[1],
      b[2]
    ],
    port: SYN_PORT
  };
}
var self_ = null;
registerBridge(2, (socket, { data }) => {
  if (data.length < 1 + ID_LEN + 2 || data[0] !== TAG_REGISTER) return;
  const idHex = Array.from(data.subarray(1, 1 + ID_LEN), (b) => b.toString(16).padStart(2, "0")).join("");
  const udpPort = data[1 + ID_LEN] << 8 | data[2 + ID_LEN];
  self_ = {
    idHex,
    udpPort,
    controlSocket: socket
  };
  const mine = synAddr(idHex);
  const assigned = new Uint8Array(1 + 4 + 2);
  assigned[0] = TAG_ASSIGNED;
  assigned.set(mine.address, 1);
  assigned[5] = mine.port >> 8;
  assigned[6] = mine.port & 255;
  pushDatagram(socket, assigned, CONTROL_FROM);
});
function beginUpgrade({ remoteIdHex, initiator, sendSignal, onStatus = () => {
} }) {
  const remote = synAddr(remoteIdHex);
  const remoteFrom = {
    tag: "ipv4",
    val: remote
  };
  const config = new PeerConnectionConfig();
  config.setIceServers(STUN);
  const pc = new PeerConnection(config);
  let channel = null;
  let sendChain = Promise.resolve();
  const backlog = [];
  let remoteDescribed = false;
  let closed = false;
  const pendingCandidates = [];
  registerAddrRoute(remote.address, remote.port, (_socket, d) => {
    if (closed) return;
    const bytes = d.data.slice();
    if (channel) {
      overlayStats.out++;
      sendChain = sendChain.then(() => channel.send({
        tag: "binary",
        val: bytes
      })).catch((err) => console.error(`[overlay] send failed: ${describeErr(err)}`));
    } else if (backlog.length < 64) {
      backlog.push(bytes);
    } else {
      overlayStats.droppedWhileConnecting++;
    }
  });
  function pumpChannel(ch) {
    void (async () => {
      for (; ; ) {
        let message;
        try {
          message = await ch.receive();
        } catch {
          onStatus("channel closed");
          return;
        }
        overlayStats.in++;
        const bytes = message.tag === "binary" ? message.val : new TextEncoder().encode(message.val);
        const sock = self_ && socketByLocalPort(self_.udpPort);
        if (sock) pushDatagram(sock, bytes, remoteFrom);
      }
    })();
  }
  function trickleLocal() {
    void (async () => {
      const reader = pc.localIceCandidates().getReader();
      for (; ; ) {
        const { value, done } = await reader.read();
        if (done) break;
        sendSignal({
          k: "cand",
          c: value
        });
      }
    })().catch(() => {
    });
  }
  async function firstIncomingChannel() {
    const reader = pc.incomingDataChannels().getReader();
    const { value, done } = await reader.read();
    reader.releaseLock();
    if (done) throw new Error("peer connection closed before a channel arrived");
    return value;
  }
  function channelOpen(ch) {
    channel = ch;
    pumpChannel(ch);
    onStatus("channel open");
    for (const bytes of backlog.splice(0)) {
      overlayStats.out++;
      sendChain = sendChain.then(() => channel.send({
        tag: "binary",
        val: bytes
      })).catch(() => {
      });
    }
    if (self_) pushDatagram(self_.controlSocket, new Uint8Array([
      TAG_READY
    ]), CONTROL_FROM);
  }
  if (initiator) {
    void (async () => {
      try {
        const options = new DataChannelOptions();
        options.setLabel("quic");
        options.setOrdered(false);
        options.setMaxRetransmits(0);
        const ch = pc.createDataChannel(options);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendSignal({
          k: "desc",
          d: offer
        });
        trickleLocal();
        await pc.waitConnected();
        channelOpen(ch);
      } catch (err) {
        onStatus(`upgrade failed: ${describeErr(err)}`);
      }
    })();
  }
  return {
    async signal(msg) {
      if (closed) return;
      try {
        if (msg.k === "desc" && msg.d.kind === "offer") {
          await pc.setRemoteDescription(msg.d);
          remoteDescribed = true;
          for (const c of pendingCandidates.splice(0)) await pc.addIceCandidate(c);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          sendSignal({
            k: "desc",
            d: answer
          });
          trickleLocal();
          const ch = await firstIncomingChannel();
          await pc.waitConnected();
          channelOpen(ch);
        } else if (msg.k === "desc") {
          await pc.setRemoteDescription(msg.d);
          remoteDescribed = true;
          for (const c of pendingCandidates.splice(0)) await pc.addIceCandidate(c);
        } else if (msg.k === "cand") {
          if (remoteDescribed) await pc.addIceCandidate(msg.c);
          else pendingCandidates.push(msg.c);
        }
      } catch (err) {
        onStatus(`signaling failed: ${describeErr(err)}`);
      }
    },
    close() {
      closed = true;
      channel = null;
      try {
        pc.close();
      } catch {
      }
    }
  };
}

// web/vendor/qrcode.mjs
var qrcode = function(typeNumber, errorCorrectionLevel) {
  const PAD0 = 236;
  const PAD1 = 17;
  let _typeNumber = typeNumber;
  const _errorCorrectionLevel = QRErrorCorrectionLevel[errorCorrectionLevel];
  let _modules = null;
  let _moduleCount = 0;
  let _dataCache = null;
  const _dataList = [];
  const _this = {};
  const makeImpl = function(test, maskPattern) {
    _moduleCount = _typeNumber * 4 + 17;
    _modules = function(moduleCount) {
      const modules = new Array(moduleCount);
      for (let row = 0; row < moduleCount; row += 1) {
        modules[row] = new Array(moduleCount);
        for (let col = 0; col < moduleCount; col += 1) {
          modules[row][col] = null;
        }
      }
      return modules;
    }(_moduleCount);
    setupPositionProbePattern(0, 0);
    setupPositionProbePattern(_moduleCount - 7, 0);
    setupPositionProbePattern(0, _moduleCount - 7);
    setupPositionAdjustPattern();
    setupTimingPattern();
    setupTypeInfo(test, maskPattern);
    if (_typeNumber >= 7) {
      setupTypeNumber(test);
    }
    if (_dataCache == null) {
      _dataCache = createData(_typeNumber, _errorCorrectionLevel, _dataList);
    }
    mapData(_dataCache, maskPattern);
  };
  const setupPositionProbePattern = function(row, col) {
    for (let r = -1; r <= 7; r += 1) {
      if (row + r <= -1 || _moduleCount <= row + r) continue;
      for (let c = -1; c <= 7; c += 1) {
        if (col + c <= -1 || _moduleCount <= col + c) continue;
        if (0 <= r && r <= 6 && (c == 0 || c == 6) || 0 <= c && c <= 6 && (r == 0 || r == 6) || 2 <= r && r <= 4 && 2 <= c && c <= 4) {
          _modules[row + r][col + c] = true;
        } else {
          _modules[row + r][col + c] = false;
        }
      }
    }
  };
  const getBestMaskPattern = function() {
    let minLostPoint = 0;
    let pattern = 0;
    for (let i = 0; i < 8; i += 1) {
      makeImpl(true, i);
      const lostPoint = QRUtil.getLostPoint(_this);
      if (i == 0 || minLostPoint > lostPoint) {
        minLostPoint = lostPoint;
        pattern = i;
      }
    }
    return pattern;
  };
  const setupTimingPattern = function() {
    for (let r = 8; r < _moduleCount - 8; r += 1) {
      if (_modules[r][6] != null) {
        continue;
      }
      _modules[r][6] = r % 2 == 0;
    }
    for (let c = 8; c < _moduleCount - 8; c += 1) {
      if (_modules[6][c] != null) {
        continue;
      }
      _modules[6][c] = c % 2 == 0;
    }
  };
  const setupPositionAdjustPattern = function() {
    const pos = QRUtil.getPatternPosition(_typeNumber);
    for (let i = 0; i < pos.length; i += 1) {
      for (let j = 0; j < pos.length; j += 1) {
        const row = pos[i];
        const col = pos[j];
        if (_modules[row][col] != null) {
          continue;
        }
        for (let r = -2; r <= 2; r += 1) {
          for (let c = -2; c <= 2; c += 1) {
            if (r == -2 || r == 2 || c == -2 || c == 2 || r == 0 && c == 0) {
              _modules[row + r][col + c] = true;
            } else {
              _modules[row + r][col + c] = false;
            }
          }
        }
      }
    }
  };
  const setupTypeNumber = function(test) {
    const bits = QRUtil.getBCHTypeNumber(_typeNumber);
    for (let i = 0; i < 18; i += 1) {
      const mod = !test && (bits >> i & 1) == 1;
      _modules[Math.floor(i / 3)][i % 3 + _moduleCount - 8 - 3] = mod;
    }
    for (let i = 0; i < 18; i += 1) {
      const mod = !test && (bits >> i & 1) == 1;
      _modules[i % 3 + _moduleCount - 8 - 3][Math.floor(i / 3)] = mod;
    }
  };
  const setupTypeInfo = function(test, maskPattern) {
    const data = _errorCorrectionLevel << 3 | maskPattern;
    const bits = QRUtil.getBCHTypeInfo(data);
    for (let i = 0; i < 15; i += 1) {
      const mod = !test && (bits >> i & 1) == 1;
      if (i < 6) {
        _modules[i][8] = mod;
      } else if (i < 8) {
        _modules[i + 1][8] = mod;
      } else {
        _modules[_moduleCount - 15 + i][8] = mod;
      }
    }
    for (let i = 0; i < 15; i += 1) {
      const mod = !test && (bits >> i & 1) == 1;
      if (i < 8) {
        _modules[8][_moduleCount - i - 1] = mod;
      } else if (i < 9) {
        _modules[8][15 - i - 1 + 1] = mod;
      } else {
        _modules[8][15 - i - 1] = mod;
      }
    }
    _modules[_moduleCount - 8][8] = !test;
  };
  const mapData = function(data, maskPattern) {
    let inc = -1;
    let row = _moduleCount - 1;
    let bitIndex = 7;
    let byteIndex = 0;
    const maskFunc = QRUtil.getMaskFunction(maskPattern);
    for (let col = _moduleCount - 1; col > 0; col -= 2) {
      if (col == 6) col -= 1;
      while (true) {
        for (let c = 0; c < 2; c += 1) {
          if (_modules[row][col - c] == null) {
            let dark = false;
            if (byteIndex < data.length) {
              dark = (data[byteIndex] >>> bitIndex & 1) == 1;
            }
            const mask = maskFunc(row, col - c);
            if (mask) {
              dark = !dark;
            }
            _modules[row][col - c] = dark;
            bitIndex -= 1;
            if (bitIndex == -1) {
              byteIndex += 1;
              bitIndex = 7;
            }
          }
        }
        row += inc;
        if (row < 0 || _moduleCount <= row) {
          row -= inc;
          inc = -inc;
          break;
        }
      }
    }
  };
  const createBytes = function(buffer, rsBlocks) {
    let offset = 0;
    let maxDcCount = 0;
    let maxEcCount = 0;
    const dcdata = new Array(rsBlocks.length);
    const ecdata = new Array(rsBlocks.length);
    for (let r = 0; r < rsBlocks.length; r += 1) {
      const dcCount = rsBlocks[r].dataCount;
      const ecCount = rsBlocks[r].totalCount - dcCount;
      maxDcCount = Math.max(maxDcCount, dcCount);
      maxEcCount = Math.max(maxEcCount, ecCount);
      dcdata[r] = new Array(dcCount);
      for (let i = 0; i < dcdata[r].length; i += 1) {
        dcdata[r][i] = 255 & buffer.getBuffer()[i + offset];
      }
      offset += dcCount;
      const rsPoly = QRUtil.getErrorCorrectPolynomial(ecCount);
      const rawPoly = qrPolynomial(dcdata[r], rsPoly.getLength() - 1);
      const modPoly = rawPoly.mod(rsPoly);
      ecdata[r] = new Array(rsPoly.getLength() - 1);
      for (let i = 0; i < ecdata[r].length; i += 1) {
        const modIndex = i + modPoly.getLength() - ecdata[r].length;
        ecdata[r][i] = modIndex >= 0 ? modPoly.getAt(modIndex) : 0;
      }
    }
    let totalCodeCount = 0;
    for (let i = 0; i < rsBlocks.length; i += 1) {
      totalCodeCount += rsBlocks[i].totalCount;
    }
    const data = new Array(totalCodeCount);
    let index = 0;
    for (let i = 0; i < maxDcCount; i += 1) {
      for (let r = 0; r < rsBlocks.length; r += 1) {
        if (i < dcdata[r].length) {
          data[index] = dcdata[r][i];
          index += 1;
        }
      }
    }
    for (let i = 0; i < maxEcCount; i += 1) {
      for (let r = 0; r < rsBlocks.length; r += 1) {
        if (i < ecdata[r].length) {
          data[index] = ecdata[r][i];
          index += 1;
        }
      }
    }
    return data;
  };
  const createData = function(typeNumber2, errorCorrectionLevel2, dataList) {
    const rsBlocks = QRRSBlock.getRSBlocks(typeNumber2, errorCorrectionLevel2);
    const buffer = qrBitBuffer();
    for (let i = 0; i < dataList.length; i += 1) {
      const data = dataList[i];
      buffer.put(data.getMode(), 4);
      buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber2));
      data.write(buffer);
    }
    let totalDataCount = 0;
    for (let i = 0; i < rsBlocks.length; i += 1) {
      totalDataCount += rsBlocks[i].dataCount;
    }
    if (buffer.getLengthInBits() > totalDataCount * 8) {
      throw "code length overflow. (" + buffer.getLengthInBits() + ">" + totalDataCount * 8 + ")";
    }
    if (buffer.getLengthInBits() + 4 <= totalDataCount * 8) {
      buffer.put(0, 4);
    }
    while (buffer.getLengthInBits() % 8 != 0) {
      buffer.putBit(false);
    }
    while (true) {
      if (buffer.getLengthInBits() >= totalDataCount * 8) {
        break;
      }
      buffer.put(PAD0, 8);
      if (buffer.getLengthInBits() >= totalDataCount * 8) {
        break;
      }
      buffer.put(PAD1, 8);
    }
    return createBytes(buffer, rsBlocks);
  };
  _this.addData = function(data, mode) {
    mode = mode || "Byte";
    let newData = null;
    switch (mode) {
      case "Numeric":
        newData = qrNumber(data);
        break;
      case "Alphanumeric":
        newData = qrAlphaNum(data);
        break;
      case "Byte":
        newData = qr8BitByte(data);
        break;
      case "Kanji":
        newData = qrKanji(data);
        break;
      default:
        throw "mode:" + mode;
    }
    _dataList.push(newData);
    _dataCache = null;
  };
  _this.isDark = function(row, col) {
    if (row < 0 || _moduleCount <= row || col < 0 || _moduleCount <= col) {
      throw row + "," + col;
    }
    return _modules[row][col];
  };
  _this.getModuleCount = function() {
    return _moduleCount;
  };
  _this.make = function() {
    if (_typeNumber < 1) {
      let typeNumber2 = 1;
      for (; typeNumber2 < 40; typeNumber2++) {
        const rsBlocks = QRRSBlock.getRSBlocks(typeNumber2, _errorCorrectionLevel);
        const buffer = qrBitBuffer();
        for (let i = 0; i < _dataList.length; i++) {
          const data = _dataList[i];
          buffer.put(data.getMode(), 4);
          buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber2));
          data.write(buffer);
        }
        let totalDataCount = 0;
        for (let i = 0; i < rsBlocks.length; i++) {
          totalDataCount += rsBlocks[i].dataCount;
        }
        if (buffer.getLengthInBits() <= totalDataCount * 8) {
          break;
        }
      }
      _typeNumber = typeNumber2;
    }
    makeImpl(false, getBestMaskPattern());
  };
  _this.createTableTag = function(cellSize, margin) {
    cellSize = cellSize || 2;
    margin = typeof margin == "undefined" ? cellSize * 4 : margin;
    let qrHtml = "";
    qrHtml += '<table style="';
    qrHtml += " border-width: 0px; border-style: none;";
    qrHtml += " border-collapse: collapse;";
    qrHtml += " padding: 0px; margin: " + margin + "px;";
    qrHtml += '">';
    qrHtml += "<tbody>";
    for (let r = 0; r < _this.getModuleCount(); r += 1) {
      qrHtml += "<tr>";
      for (let c = 0; c < _this.getModuleCount(); c += 1) {
        qrHtml += '<td style="';
        qrHtml += " border-width: 0px; border-style: none;";
        qrHtml += " border-collapse: collapse;";
        qrHtml += " padding: 0px; margin: 0px;";
        qrHtml += " width: " + cellSize + "px;";
        qrHtml += " height: " + cellSize + "px;";
        qrHtml += " background-color: ";
        qrHtml += _this.isDark(r, c) ? "#000000" : "#ffffff";
        qrHtml += ";";
        qrHtml += '"/>';
      }
      qrHtml += "</tr>";
    }
    qrHtml += "</tbody>";
    qrHtml += "</table>";
    return qrHtml;
  };
  _this.createSvgTag = function(cellSize, margin, alt, title) {
    let opts = {};
    if (typeof arguments[0] == "object") {
      opts = arguments[0];
      cellSize = opts.cellSize;
      margin = opts.margin;
      alt = opts.alt;
      title = opts.title;
    }
    cellSize = cellSize || 2;
    margin = typeof margin == "undefined" ? cellSize * 4 : margin;
    alt = typeof alt === "string" ? {
      text: alt
    } : alt || {};
    alt.text = alt.text || null;
    alt.id = alt.text ? alt.id || "qrcode-description" : null;
    title = typeof title === "string" ? {
      text: title
    } : title || {};
    title.text = title.text || null;
    title.id = title.text ? title.id || "qrcode-title" : null;
    const size = _this.getModuleCount() * cellSize + margin * 2;
    let c, mc, r, mr, qrSvg = "", rect;
    rect = "l" + cellSize + ",0 0," + cellSize + " -" + cellSize + ",0 0,-" + cellSize + "z ";
    qrSvg += '<svg version="1.1" xmlns="http://www.w3.org/2000/svg"';
    qrSvg += !opts.scalable ? ' width="' + size + 'px" height="' + size + 'px"' : "";
    qrSvg += ' viewBox="0 0 ' + size + " " + size + '" ';
    qrSvg += ' preserveAspectRatio="xMinYMin meet"';
    qrSvg += title.text || alt.text ? ' role="img" aria-labelledby="' + escapeXml([
      title.id,
      alt.id
    ].join(" ").trim()) + '"' : "";
    qrSvg += ">";
    qrSvg += title.text ? '<title id="' + escapeXml(title.id) + '">' + escapeXml(title.text) + "</title>" : "";
    qrSvg += alt.text ? '<description id="' + escapeXml(alt.id) + '">' + escapeXml(alt.text) + "</description>" : "";
    qrSvg += '<rect width="100%" height="100%" fill="white" cx="0" cy="0"/>';
    qrSvg += '<path d="';
    for (r = 0; r < _this.getModuleCount(); r += 1) {
      mr = r * cellSize + margin;
      for (c = 0; c < _this.getModuleCount(); c += 1) {
        if (_this.isDark(r, c)) {
          mc = c * cellSize + margin;
          qrSvg += "M" + mc + "," + mr + rect;
        }
      }
    }
    qrSvg += '" stroke="transparent" fill="black"/>';
    qrSvg += "</svg>";
    return qrSvg;
  };
  _this.createDataURL = function(cellSize, margin) {
    cellSize = cellSize || 2;
    margin = typeof margin == "undefined" ? cellSize * 4 : margin;
    const size = _this.getModuleCount() * cellSize + margin * 2;
    const min = margin;
    const max = size - margin;
    return createDataURL(size, size, function(x, y) {
      if (min <= x && x < max && min <= y && y < max) {
        const c = Math.floor((x - min) / cellSize);
        const r = Math.floor((y - min) / cellSize);
        return _this.isDark(r, c) ? 0 : 1;
      } else {
        return 1;
      }
    });
  };
  _this.createImgTag = function(cellSize, margin, alt) {
    cellSize = cellSize || 2;
    margin = typeof margin == "undefined" ? cellSize * 4 : margin;
    const size = _this.getModuleCount() * cellSize + margin * 2;
    let img = "";
    img += "<img";
    img += ' src="';
    img += _this.createDataURL(cellSize, margin);
    img += '"';
    img += ' width="';
    img += size;
    img += '"';
    img += ' height="';
    img += size;
    img += '"';
    if (alt) {
      img += ' alt="';
      img += escapeXml(alt);
      img += '"';
    }
    img += "/>";
    return img;
  };
  const escapeXml = function(s) {
    let escaped = "";
    for (let i = 0; i < s.length; i += 1) {
      const c = s.charAt(i);
      switch (c) {
        case "<":
          escaped += "&lt;";
          break;
        case ">":
          escaped += "&gt;";
          break;
        case "&":
          escaped += "&amp;";
          break;
        case '"':
          escaped += "&quot;";
          break;
        default:
          escaped += c;
          break;
      }
    }
    return escaped;
  };
  const _createHalfASCII = function(margin) {
    const cellSize = 1;
    margin = typeof margin == "undefined" ? cellSize * 2 : margin;
    const size = _this.getModuleCount() * cellSize + margin * 2;
    const min = margin;
    const max = size - margin;
    let y, x, r1, r2, p;
    const blocks = {
      "\u2588\u2588": "\u2588",
      "\u2588 ": "\u2580",
      " \u2588": "\u2584",
      "  ": " "
    };
    const blocksLastLineNoMargin = {
      "\u2588\u2588": "\u2580",
      "\u2588 ": "\u2580",
      " \u2588": " ",
      "  ": " "
    };
    let ascii = "";
    for (y = 0; y < size; y += 2) {
      r1 = Math.floor((y - min) / cellSize);
      r2 = Math.floor((y + 1 - min) / cellSize);
      for (x = 0; x < size; x += 1) {
        p = "\u2588";
        if (min <= x && x < max && min <= y && y < max && _this.isDark(r1, Math.floor((x - min) / cellSize))) {
          p = " ";
        }
        if (min <= x && x < max && min <= y + 1 && y + 1 < max && _this.isDark(r2, Math.floor((x - min) / cellSize))) {
          p += " ";
        } else {
          p += "\u2588";
        }
        ascii += margin < 1 && y + 1 >= max ? blocksLastLineNoMargin[p] : blocks[p];
      }
      ascii += "\n";
    }
    if (size % 2 && margin > 0) {
      return ascii.substring(0, ascii.length - size - 1) + Array(size + 1).join("\u2580");
    }
    return ascii.substring(0, ascii.length - 1);
  };
  _this.createASCII = function(cellSize, margin) {
    cellSize = cellSize || 1;
    if (cellSize < 2) {
      return _createHalfASCII(margin);
    }
    cellSize -= 1;
    margin = typeof margin == "undefined" ? cellSize * 2 : margin;
    const size = _this.getModuleCount() * cellSize + margin * 2;
    const min = margin;
    const max = size - margin;
    let y, x, r, p;
    const white = Array(cellSize + 1).join("\u2588\u2588");
    const black = Array(cellSize + 1).join("  ");
    let ascii = "";
    let line = "";
    for (y = 0; y < size; y += 1) {
      r = Math.floor((y - min) / cellSize);
      line = "";
      for (x = 0; x < size; x += 1) {
        p = 1;
        if (min <= x && x < max && min <= y && y < max && _this.isDark(r, Math.floor((x - min) / cellSize))) {
          p = 0;
        }
        line += p ? white : black;
      }
      for (r = 0; r < cellSize; r += 1) {
        ascii += line + "\n";
      }
    }
    return ascii.substring(0, ascii.length - 1);
  };
  _this.renderTo2dContext = function(context, cellSize) {
    cellSize = cellSize || 2;
    const length = _this.getModuleCount();
    for (let row = 0; row < length; row++) {
      for (let col = 0; col < length; col++) {
        context.fillStyle = _this.isDark(row, col) ? "black" : "white";
        context.fillRect(col * cellSize, row * cellSize, cellSize, cellSize);
      }
    }
  };
  return _this;
};
qrcode.stringToBytes = function(s) {
  const bytes = [];
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    bytes.push(c & 255);
  }
  return bytes;
};
qrcode.createStringToBytes = function(unicodeData, numChars) {
  const unicodeMap = function() {
    const bin = base64DecodeInputStream(unicodeData);
    const read = function() {
      const b = bin.read();
      if (b == -1) throw "eof";
      return b;
    };
    let count = 0;
    const unicodeMap2 = {};
    while (true) {
      const b0 = bin.read();
      if (b0 == -1) break;
      const b1 = read();
      const b2 = read();
      const b3 = read();
      const k = String.fromCharCode(b0 << 8 | b1);
      const v = b2 << 8 | b3;
      unicodeMap2[k] = v;
      count += 1;
    }
    if (count != numChars) {
      throw count + " != " + numChars;
    }
    return unicodeMap2;
  }();
  const unknownChar = "?".charCodeAt(0);
  return function(s) {
    const bytes = [];
    for (let i = 0; i < s.length; i += 1) {
      const c = s.charCodeAt(i);
      if (c < 128) {
        bytes.push(c);
      } else {
        const b = unicodeMap[s.charAt(i)];
        if (typeof b == "number") {
          if ((b & 255) == b) {
            bytes.push(b);
          } else {
            bytes.push(b >>> 8);
            bytes.push(b & 255);
          }
        } else {
          bytes.push(unknownChar);
        }
      }
    }
    return bytes;
  };
};
var QRMode = {
  MODE_NUMBER: 1 << 0,
  MODE_ALPHA_NUM: 1 << 1,
  MODE_8BIT_BYTE: 1 << 2,
  MODE_KANJI: 1 << 3
};
var QRErrorCorrectionLevel = {
  L: 1,
  M: 0,
  Q: 3,
  H: 2
};
var QRMaskPattern = {
  PATTERN000: 0,
  PATTERN001: 1,
  PATTERN010: 2,
  PATTERN011: 3,
  PATTERN100: 4,
  PATTERN101: 5,
  PATTERN110: 6,
  PATTERN111: 7
};
var QRUtil = function() {
  const PATTERN_POSITION_TABLE = [
    [],
    [
      6,
      18
    ],
    [
      6,
      22
    ],
    [
      6,
      26
    ],
    [
      6,
      30
    ],
    [
      6,
      34
    ],
    [
      6,
      22,
      38
    ],
    [
      6,
      24,
      42
    ],
    [
      6,
      26,
      46
    ],
    [
      6,
      28,
      50
    ],
    [
      6,
      30,
      54
    ],
    [
      6,
      32,
      58
    ],
    [
      6,
      34,
      62
    ],
    [
      6,
      26,
      46,
      66
    ],
    [
      6,
      26,
      48,
      70
    ],
    [
      6,
      26,
      50,
      74
    ],
    [
      6,
      30,
      54,
      78
    ],
    [
      6,
      30,
      56,
      82
    ],
    [
      6,
      30,
      58,
      86
    ],
    [
      6,
      34,
      62,
      90
    ],
    [
      6,
      28,
      50,
      72,
      94
    ],
    [
      6,
      26,
      50,
      74,
      98
    ],
    [
      6,
      30,
      54,
      78,
      102
    ],
    [
      6,
      28,
      54,
      80,
      106
    ],
    [
      6,
      32,
      58,
      84,
      110
    ],
    [
      6,
      30,
      58,
      86,
      114
    ],
    [
      6,
      34,
      62,
      90,
      118
    ],
    [
      6,
      26,
      50,
      74,
      98,
      122
    ],
    [
      6,
      30,
      54,
      78,
      102,
      126
    ],
    [
      6,
      26,
      52,
      78,
      104,
      130
    ],
    [
      6,
      30,
      56,
      82,
      108,
      134
    ],
    [
      6,
      34,
      60,
      86,
      112,
      138
    ],
    [
      6,
      30,
      58,
      86,
      114,
      142
    ],
    [
      6,
      34,
      62,
      90,
      118,
      146
    ],
    [
      6,
      30,
      54,
      78,
      102,
      126,
      150
    ],
    [
      6,
      24,
      50,
      76,
      102,
      128,
      154
    ],
    [
      6,
      28,
      54,
      80,
      106,
      132,
      158
    ],
    [
      6,
      32,
      58,
      84,
      110,
      136,
      162
    ],
    [
      6,
      26,
      54,
      82,
      110,
      138,
      166
    ],
    [
      6,
      30,
      58,
      86,
      114,
      142,
      170
    ]
  ];
  const G15 = 1 << 10 | 1 << 8 | 1 << 5 | 1 << 4 | 1 << 2 | 1 << 1 | 1 << 0;
  const G18 = 1 << 12 | 1 << 11 | 1 << 10 | 1 << 9 | 1 << 8 | 1 << 5 | 1 << 2 | 1 << 0;
  const G15_MASK = 1 << 14 | 1 << 12 | 1 << 10 | 1 << 4 | 1 << 1;
  const _this = {};
  const getBCHDigit = function(data) {
    let digit = 0;
    while (data != 0) {
      digit += 1;
      data >>>= 1;
    }
    return digit;
  };
  _this.getBCHTypeInfo = function(data) {
    let d = data << 10;
    while (getBCHDigit(d) - getBCHDigit(G15) >= 0) {
      d ^= G15 << getBCHDigit(d) - getBCHDigit(G15);
    }
    return (data << 10 | d) ^ G15_MASK;
  };
  _this.getBCHTypeNumber = function(data) {
    let d = data << 12;
    while (getBCHDigit(d) - getBCHDigit(G18) >= 0) {
      d ^= G18 << getBCHDigit(d) - getBCHDigit(G18);
    }
    return data << 12 | d;
  };
  _this.getPatternPosition = function(typeNumber) {
    return PATTERN_POSITION_TABLE[typeNumber - 1];
  };
  _this.getMaskFunction = function(maskPattern) {
    switch (maskPattern) {
      case QRMaskPattern.PATTERN000:
        return function(i, j) {
          return (i + j) % 2 == 0;
        };
      case QRMaskPattern.PATTERN001:
        return function(i, j) {
          return i % 2 == 0;
        };
      case QRMaskPattern.PATTERN010:
        return function(i, j) {
          return j % 3 == 0;
        };
      case QRMaskPattern.PATTERN011:
        return function(i, j) {
          return (i + j) % 3 == 0;
        };
      case QRMaskPattern.PATTERN100:
        return function(i, j) {
          return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 == 0;
        };
      case QRMaskPattern.PATTERN101:
        return function(i, j) {
          return i * j % 2 + i * j % 3 == 0;
        };
      case QRMaskPattern.PATTERN110:
        return function(i, j) {
          return (i * j % 2 + i * j % 3) % 2 == 0;
        };
      case QRMaskPattern.PATTERN111:
        return function(i, j) {
          return (i * j % 3 + (i + j) % 2) % 2 == 0;
        };
      default:
        throw "bad maskPattern:" + maskPattern;
    }
  };
  _this.getErrorCorrectPolynomial = function(errorCorrectLength) {
    let a = qrPolynomial([
      1
    ], 0);
    for (let i = 0; i < errorCorrectLength; i += 1) {
      a = a.multiply(qrPolynomial([
        1,
        QRMath.gexp(i)
      ], 0));
    }
    return a;
  };
  _this.getLengthInBits = function(mode, type) {
    if (1 <= type && type < 10) {
      switch (mode) {
        case QRMode.MODE_NUMBER:
          return 10;
        case QRMode.MODE_ALPHA_NUM:
          return 9;
        case QRMode.MODE_8BIT_BYTE:
          return 8;
        case QRMode.MODE_KANJI:
          return 8;
        default:
          throw "mode:" + mode;
      }
    } else if (type < 27) {
      switch (mode) {
        case QRMode.MODE_NUMBER:
          return 12;
        case QRMode.MODE_ALPHA_NUM:
          return 11;
        case QRMode.MODE_8BIT_BYTE:
          return 16;
        case QRMode.MODE_KANJI:
          return 10;
        default:
          throw "mode:" + mode;
      }
    } else if (type < 41) {
      switch (mode) {
        case QRMode.MODE_NUMBER:
          return 14;
        case QRMode.MODE_ALPHA_NUM:
          return 13;
        case QRMode.MODE_8BIT_BYTE:
          return 16;
        case QRMode.MODE_KANJI:
          return 12;
        default:
          throw "mode:" + mode;
      }
    } else {
      throw "type:" + type;
    }
  };
  _this.getLostPoint = function(qrcode2) {
    const moduleCount = qrcode2.getModuleCount();
    let lostPoint = 0;
    for (let row = 0; row < moduleCount; row += 1) {
      for (let col = 0; col < moduleCount; col += 1) {
        let sameCount = 0;
        const dark = qrcode2.isDark(row, col);
        for (let r = -1; r <= 1; r += 1) {
          if (row + r < 0 || moduleCount <= row + r) {
            continue;
          }
          for (let c = -1; c <= 1; c += 1) {
            if (col + c < 0 || moduleCount <= col + c) {
              continue;
            }
            if (r == 0 && c == 0) {
              continue;
            }
            if (dark == qrcode2.isDark(row + r, col + c)) {
              sameCount += 1;
            }
          }
        }
        if (sameCount > 5) {
          lostPoint += 3 + sameCount - 5;
        }
      }
    }
    ;
    for (let row = 0; row < moduleCount - 1; row += 1) {
      for (let col = 0; col < moduleCount - 1; col += 1) {
        let count = 0;
        if (qrcode2.isDark(row, col)) count += 1;
        if (qrcode2.isDark(row + 1, col)) count += 1;
        if (qrcode2.isDark(row, col + 1)) count += 1;
        if (qrcode2.isDark(row + 1, col + 1)) count += 1;
        if (count == 0 || count == 4) {
          lostPoint += 3;
        }
      }
    }
    for (let row = 0; row < moduleCount; row += 1) {
      for (let col = 0; col < moduleCount - 6; col += 1) {
        if (qrcode2.isDark(row, col) && !qrcode2.isDark(row, col + 1) && qrcode2.isDark(row, col + 2) && qrcode2.isDark(row, col + 3) && qrcode2.isDark(row, col + 4) && !qrcode2.isDark(row, col + 5) && qrcode2.isDark(row, col + 6)) {
          lostPoint += 40;
        }
      }
    }
    for (let col = 0; col < moduleCount; col += 1) {
      for (let row = 0; row < moduleCount - 6; row += 1) {
        if (qrcode2.isDark(row, col) && !qrcode2.isDark(row + 1, col) && qrcode2.isDark(row + 2, col) && qrcode2.isDark(row + 3, col) && qrcode2.isDark(row + 4, col) && !qrcode2.isDark(row + 5, col) && qrcode2.isDark(row + 6, col)) {
          lostPoint += 40;
        }
      }
    }
    let darkCount = 0;
    for (let col = 0; col < moduleCount; col += 1) {
      for (let row = 0; row < moduleCount; row += 1) {
        if (qrcode2.isDark(row, col)) {
          darkCount += 1;
        }
      }
    }
    const ratio = Math.abs(100 * darkCount / moduleCount / moduleCount - 50) / 5;
    lostPoint += ratio * 10;
    return lostPoint;
  };
  return _this;
}();
var QRMath = function() {
  const EXP_TABLE = new Array(256);
  const LOG_TABLE = new Array(256);
  for (let i = 0; i < 8; i += 1) {
    EXP_TABLE[i] = 1 << i;
  }
  for (let i = 8; i < 256; i += 1) {
    EXP_TABLE[i] = EXP_TABLE[i - 4] ^ EXP_TABLE[i - 5] ^ EXP_TABLE[i - 6] ^ EXP_TABLE[i - 8];
  }
  for (let i = 0; i < 255; i += 1) {
    LOG_TABLE[EXP_TABLE[i]] = i;
  }
  const _this = {};
  _this.glog = function(n) {
    if (n < 1) {
      throw "glog(" + n + ")";
    }
    return LOG_TABLE[n];
  };
  _this.gexp = function(n) {
    while (n < 0) {
      n += 255;
    }
    while (n >= 256) {
      n -= 255;
    }
    return EXP_TABLE[n];
  };
  return _this;
}();
var qrPolynomial = function(num, shift) {
  if (typeof num.length == "undefined") {
    throw num.length + "/" + shift;
  }
  const _num = function() {
    let offset = 0;
    while (offset < num.length && num[offset] == 0) {
      offset += 1;
    }
    const _num2 = new Array(num.length - offset + shift);
    for (let i = 0; i < num.length - offset; i += 1) {
      _num2[i] = num[i + offset];
    }
    return _num2;
  }();
  const _this = {};
  _this.getAt = function(index) {
    return _num[index];
  };
  _this.getLength = function() {
    return _num.length;
  };
  _this.multiply = function(e) {
    const num2 = new Array(_this.getLength() + e.getLength() - 1);
    for (let i = 0; i < _this.getLength(); i += 1) {
      for (let j = 0; j < e.getLength(); j += 1) {
        num2[i + j] ^= QRMath.gexp(QRMath.glog(_this.getAt(i)) + QRMath.glog(e.getAt(j)));
      }
    }
    return qrPolynomial(num2, 0);
  };
  _this.mod = function(e) {
    if (_this.getLength() - e.getLength() < 0) {
      return _this;
    }
    const ratio = QRMath.glog(_this.getAt(0)) - QRMath.glog(e.getAt(0));
    const num2 = new Array(_this.getLength());
    for (let i = 0; i < _this.getLength(); i += 1) {
      num2[i] = _this.getAt(i);
    }
    for (let i = 0; i < e.getLength(); i += 1) {
      num2[i] ^= QRMath.gexp(QRMath.glog(e.getAt(i)) + ratio);
    }
    return qrPolynomial(num2, 0).mod(e);
  };
  return _this;
};
var QRRSBlock = function() {
  const RS_BLOCK_TABLE = [
    // L
    // M
    // Q
    // H
    // 1
    [
      1,
      26,
      19
    ],
    [
      1,
      26,
      16
    ],
    [
      1,
      26,
      13
    ],
    [
      1,
      26,
      9
    ],
    // 2
    [
      1,
      44,
      34
    ],
    [
      1,
      44,
      28
    ],
    [
      1,
      44,
      22
    ],
    [
      1,
      44,
      16
    ],
    // 3
    [
      1,
      70,
      55
    ],
    [
      1,
      70,
      44
    ],
    [
      2,
      35,
      17
    ],
    [
      2,
      35,
      13
    ],
    // 4
    [
      1,
      100,
      80
    ],
    [
      2,
      50,
      32
    ],
    [
      2,
      50,
      24
    ],
    [
      4,
      25,
      9
    ],
    // 5
    [
      1,
      134,
      108
    ],
    [
      2,
      67,
      43
    ],
    [
      2,
      33,
      15,
      2,
      34,
      16
    ],
    [
      2,
      33,
      11,
      2,
      34,
      12
    ],
    // 6
    [
      2,
      86,
      68
    ],
    [
      4,
      43,
      27
    ],
    [
      4,
      43,
      19
    ],
    [
      4,
      43,
      15
    ],
    // 7
    [
      2,
      98,
      78
    ],
    [
      4,
      49,
      31
    ],
    [
      2,
      32,
      14,
      4,
      33,
      15
    ],
    [
      4,
      39,
      13,
      1,
      40,
      14
    ],
    // 8
    [
      2,
      121,
      97
    ],
    [
      2,
      60,
      38,
      2,
      61,
      39
    ],
    [
      4,
      40,
      18,
      2,
      41,
      19
    ],
    [
      4,
      40,
      14,
      2,
      41,
      15
    ],
    // 9
    [
      2,
      146,
      116
    ],
    [
      3,
      58,
      36,
      2,
      59,
      37
    ],
    [
      4,
      36,
      16,
      4,
      37,
      17
    ],
    [
      4,
      36,
      12,
      4,
      37,
      13
    ],
    // 10
    [
      2,
      86,
      68,
      2,
      87,
      69
    ],
    [
      4,
      69,
      43,
      1,
      70,
      44
    ],
    [
      6,
      43,
      19,
      2,
      44,
      20
    ],
    [
      6,
      43,
      15,
      2,
      44,
      16
    ],
    // 11
    [
      4,
      101,
      81
    ],
    [
      1,
      80,
      50,
      4,
      81,
      51
    ],
    [
      4,
      50,
      22,
      4,
      51,
      23
    ],
    [
      3,
      36,
      12,
      8,
      37,
      13
    ],
    // 12
    [
      2,
      116,
      92,
      2,
      117,
      93
    ],
    [
      6,
      58,
      36,
      2,
      59,
      37
    ],
    [
      4,
      46,
      20,
      6,
      47,
      21
    ],
    [
      7,
      42,
      14,
      4,
      43,
      15
    ],
    // 13
    [
      4,
      133,
      107
    ],
    [
      8,
      59,
      37,
      1,
      60,
      38
    ],
    [
      8,
      44,
      20,
      4,
      45,
      21
    ],
    [
      12,
      33,
      11,
      4,
      34,
      12
    ],
    // 14
    [
      3,
      145,
      115,
      1,
      146,
      116
    ],
    [
      4,
      64,
      40,
      5,
      65,
      41
    ],
    [
      11,
      36,
      16,
      5,
      37,
      17
    ],
    [
      11,
      36,
      12,
      5,
      37,
      13
    ],
    // 15
    [
      5,
      109,
      87,
      1,
      110,
      88
    ],
    [
      5,
      65,
      41,
      5,
      66,
      42
    ],
    [
      5,
      54,
      24,
      7,
      55,
      25
    ],
    [
      11,
      36,
      12,
      7,
      37,
      13
    ],
    // 16
    [
      5,
      122,
      98,
      1,
      123,
      99
    ],
    [
      7,
      73,
      45,
      3,
      74,
      46
    ],
    [
      15,
      43,
      19,
      2,
      44,
      20
    ],
    [
      3,
      45,
      15,
      13,
      46,
      16
    ],
    // 17
    [
      1,
      135,
      107,
      5,
      136,
      108
    ],
    [
      10,
      74,
      46,
      1,
      75,
      47
    ],
    [
      1,
      50,
      22,
      15,
      51,
      23
    ],
    [
      2,
      42,
      14,
      17,
      43,
      15
    ],
    // 18
    [
      5,
      150,
      120,
      1,
      151,
      121
    ],
    [
      9,
      69,
      43,
      4,
      70,
      44
    ],
    [
      17,
      50,
      22,
      1,
      51,
      23
    ],
    [
      2,
      42,
      14,
      19,
      43,
      15
    ],
    // 19
    [
      3,
      141,
      113,
      4,
      142,
      114
    ],
    [
      3,
      70,
      44,
      11,
      71,
      45
    ],
    [
      17,
      47,
      21,
      4,
      48,
      22
    ],
    [
      9,
      39,
      13,
      16,
      40,
      14
    ],
    // 20
    [
      3,
      135,
      107,
      5,
      136,
      108
    ],
    [
      3,
      67,
      41,
      13,
      68,
      42
    ],
    [
      15,
      54,
      24,
      5,
      55,
      25
    ],
    [
      15,
      43,
      15,
      10,
      44,
      16
    ],
    // 21
    [
      4,
      144,
      116,
      4,
      145,
      117
    ],
    [
      17,
      68,
      42
    ],
    [
      17,
      50,
      22,
      6,
      51,
      23
    ],
    [
      19,
      46,
      16,
      6,
      47,
      17
    ],
    // 22
    [
      2,
      139,
      111,
      7,
      140,
      112
    ],
    [
      17,
      74,
      46
    ],
    [
      7,
      54,
      24,
      16,
      55,
      25
    ],
    [
      34,
      37,
      13
    ],
    // 23
    [
      4,
      151,
      121,
      5,
      152,
      122
    ],
    [
      4,
      75,
      47,
      14,
      76,
      48
    ],
    [
      11,
      54,
      24,
      14,
      55,
      25
    ],
    [
      16,
      45,
      15,
      14,
      46,
      16
    ],
    // 24
    [
      6,
      147,
      117,
      4,
      148,
      118
    ],
    [
      6,
      73,
      45,
      14,
      74,
      46
    ],
    [
      11,
      54,
      24,
      16,
      55,
      25
    ],
    [
      30,
      46,
      16,
      2,
      47,
      17
    ],
    // 25
    [
      8,
      132,
      106,
      4,
      133,
      107
    ],
    [
      8,
      75,
      47,
      13,
      76,
      48
    ],
    [
      7,
      54,
      24,
      22,
      55,
      25
    ],
    [
      22,
      45,
      15,
      13,
      46,
      16
    ],
    // 26
    [
      10,
      142,
      114,
      2,
      143,
      115
    ],
    [
      19,
      74,
      46,
      4,
      75,
      47
    ],
    [
      28,
      50,
      22,
      6,
      51,
      23
    ],
    [
      33,
      46,
      16,
      4,
      47,
      17
    ],
    // 27
    [
      8,
      152,
      122,
      4,
      153,
      123
    ],
    [
      22,
      73,
      45,
      3,
      74,
      46
    ],
    [
      8,
      53,
      23,
      26,
      54,
      24
    ],
    [
      12,
      45,
      15,
      28,
      46,
      16
    ],
    // 28
    [
      3,
      147,
      117,
      10,
      148,
      118
    ],
    [
      3,
      73,
      45,
      23,
      74,
      46
    ],
    [
      4,
      54,
      24,
      31,
      55,
      25
    ],
    [
      11,
      45,
      15,
      31,
      46,
      16
    ],
    // 29
    [
      7,
      146,
      116,
      7,
      147,
      117
    ],
    [
      21,
      73,
      45,
      7,
      74,
      46
    ],
    [
      1,
      53,
      23,
      37,
      54,
      24
    ],
    [
      19,
      45,
      15,
      26,
      46,
      16
    ],
    // 30
    [
      5,
      145,
      115,
      10,
      146,
      116
    ],
    [
      19,
      75,
      47,
      10,
      76,
      48
    ],
    [
      15,
      54,
      24,
      25,
      55,
      25
    ],
    [
      23,
      45,
      15,
      25,
      46,
      16
    ],
    // 31
    [
      13,
      145,
      115,
      3,
      146,
      116
    ],
    [
      2,
      74,
      46,
      29,
      75,
      47
    ],
    [
      42,
      54,
      24,
      1,
      55,
      25
    ],
    [
      23,
      45,
      15,
      28,
      46,
      16
    ],
    // 32
    [
      17,
      145,
      115
    ],
    [
      10,
      74,
      46,
      23,
      75,
      47
    ],
    [
      10,
      54,
      24,
      35,
      55,
      25
    ],
    [
      19,
      45,
      15,
      35,
      46,
      16
    ],
    // 33
    [
      17,
      145,
      115,
      1,
      146,
      116
    ],
    [
      14,
      74,
      46,
      21,
      75,
      47
    ],
    [
      29,
      54,
      24,
      19,
      55,
      25
    ],
    [
      11,
      45,
      15,
      46,
      46,
      16
    ],
    // 34
    [
      13,
      145,
      115,
      6,
      146,
      116
    ],
    [
      14,
      74,
      46,
      23,
      75,
      47
    ],
    [
      44,
      54,
      24,
      7,
      55,
      25
    ],
    [
      59,
      46,
      16,
      1,
      47,
      17
    ],
    // 35
    [
      12,
      151,
      121,
      7,
      152,
      122
    ],
    [
      12,
      75,
      47,
      26,
      76,
      48
    ],
    [
      39,
      54,
      24,
      14,
      55,
      25
    ],
    [
      22,
      45,
      15,
      41,
      46,
      16
    ],
    // 36
    [
      6,
      151,
      121,
      14,
      152,
      122
    ],
    [
      6,
      75,
      47,
      34,
      76,
      48
    ],
    [
      46,
      54,
      24,
      10,
      55,
      25
    ],
    [
      2,
      45,
      15,
      64,
      46,
      16
    ],
    // 37
    [
      17,
      152,
      122,
      4,
      153,
      123
    ],
    [
      29,
      74,
      46,
      14,
      75,
      47
    ],
    [
      49,
      54,
      24,
      10,
      55,
      25
    ],
    [
      24,
      45,
      15,
      46,
      46,
      16
    ],
    // 38
    [
      4,
      152,
      122,
      18,
      153,
      123
    ],
    [
      13,
      74,
      46,
      32,
      75,
      47
    ],
    [
      48,
      54,
      24,
      14,
      55,
      25
    ],
    [
      42,
      45,
      15,
      32,
      46,
      16
    ],
    // 39
    [
      20,
      147,
      117,
      4,
      148,
      118
    ],
    [
      40,
      75,
      47,
      7,
      76,
      48
    ],
    [
      43,
      54,
      24,
      22,
      55,
      25
    ],
    [
      10,
      45,
      15,
      67,
      46,
      16
    ],
    // 40
    [
      19,
      148,
      118,
      6,
      149,
      119
    ],
    [
      18,
      75,
      47,
      31,
      76,
      48
    ],
    [
      34,
      54,
      24,
      34,
      55,
      25
    ],
    [
      20,
      45,
      15,
      61,
      46,
      16
    ]
  ];
  const qrRSBlock = function(totalCount, dataCount) {
    const _this2 = {};
    _this2.totalCount = totalCount;
    _this2.dataCount = dataCount;
    return _this2;
  };
  const _this = {};
  const getRsBlockTable = function(typeNumber, errorCorrectionLevel) {
    switch (errorCorrectionLevel) {
      case QRErrorCorrectionLevel.L:
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 0];
      case QRErrorCorrectionLevel.M:
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 1];
      case QRErrorCorrectionLevel.Q:
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 2];
      case QRErrorCorrectionLevel.H:
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 3];
      default:
        return void 0;
    }
  };
  _this.getRSBlocks = function(typeNumber, errorCorrectionLevel) {
    const rsBlock = getRsBlockTable(typeNumber, errorCorrectionLevel);
    if (typeof rsBlock == "undefined") {
      throw "bad rs block @ typeNumber:" + typeNumber + "/errorCorrectionLevel:" + errorCorrectionLevel;
    }
    const length = rsBlock.length / 3;
    const list = [];
    for (let i = 0; i < length; i += 1) {
      const count = rsBlock[i * 3 + 0];
      const totalCount = rsBlock[i * 3 + 1];
      const dataCount = rsBlock[i * 3 + 2];
      for (let j = 0; j < count; j += 1) {
        list.push(qrRSBlock(totalCount, dataCount));
      }
    }
    return list;
  };
  return _this;
}();
var qrBitBuffer = function() {
  const _buffer = [];
  let _length = 0;
  const _this = {};
  _this.getBuffer = function() {
    return _buffer;
  };
  _this.getAt = function(index) {
    const bufIndex = Math.floor(index / 8);
    return (_buffer[bufIndex] >>> 7 - index % 8 & 1) == 1;
  };
  _this.put = function(num, length) {
    for (let i = 0; i < length; i += 1) {
      _this.putBit((num >>> length - i - 1 & 1) == 1);
    }
  };
  _this.getLengthInBits = function() {
    return _length;
  };
  _this.putBit = function(bit) {
    const bufIndex = Math.floor(_length / 8);
    if (_buffer.length <= bufIndex) {
      _buffer.push(0);
    }
    if (bit) {
      _buffer[bufIndex] |= 128 >>> _length % 8;
    }
    _length += 1;
  };
  return _this;
};
var qrNumber = function(data) {
  const _mode = QRMode.MODE_NUMBER;
  const _data = data;
  const _this = {};
  _this.getMode = function() {
    return _mode;
  };
  _this.getLength = function(buffer) {
    return _data.length;
  };
  _this.write = function(buffer) {
    const data2 = _data;
    let i = 0;
    while (i + 2 < data2.length) {
      buffer.put(strToNum(data2.substring(i, i + 3)), 10);
      i += 3;
    }
    if (i < data2.length) {
      if (data2.length - i == 1) {
        buffer.put(strToNum(data2.substring(i, i + 1)), 4);
      } else if (data2.length - i == 2) {
        buffer.put(strToNum(data2.substring(i, i + 2)), 7);
      }
    }
  };
  const strToNum = function(s) {
    let num = 0;
    for (let i = 0; i < s.length; i += 1) {
      num = num * 10 + chatToNum(s.charAt(i));
    }
    return num;
  };
  const chatToNum = function(c) {
    if ("0" <= c && c <= "9") {
      return c.charCodeAt(0) - "0".charCodeAt(0);
    }
    throw "illegal char :" + c;
  };
  return _this;
};
var qrAlphaNum = function(data) {
  const _mode = QRMode.MODE_ALPHA_NUM;
  const _data = data;
  const _this = {};
  _this.getMode = function() {
    return _mode;
  };
  _this.getLength = function(buffer) {
    return _data.length;
  };
  _this.write = function(buffer) {
    const s = _data;
    let i = 0;
    while (i + 1 < s.length) {
      buffer.put(getCode(s.charAt(i)) * 45 + getCode(s.charAt(i + 1)), 11);
      i += 2;
    }
    if (i < s.length) {
      buffer.put(getCode(s.charAt(i)), 6);
    }
  };
  const getCode = function(c) {
    if ("0" <= c && c <= "9") {
      return c.charCodeAt(0) - "0".charCodeAt(0);
    } else if ("A" <= c && c <= "Z") {
      return c.charCodeAt(0) - "A".charCodeAt(0) + 10;
    } else {
      switch (c) {
        case " ":
          return 36;
        case "$":
          return 37;
        case "%":
          return 38;
        case "*":
          return 39;
        case "+":
          return 40;
        case "-":
          return 41;
        case ".":
          return 42;
        case "/":
          return 43;
        case ":":
          return 44;
        default:
          throw "illegal char :" + c;
      }
    }
  };
  return _this;
};
var qr8BitByte = function(data) {
  const _mode = QRMode.MODE_8BIT_BYTE;
  const _data = data;
  const _bytes = qrcode.stringToBytes(data);
  const _this = {};
  _this.getMode = function() {
    return _mode;
  };
  _this.getLength = function(buffer) {
    return _bytes.length;
  };
  _this.write = function(buffer) {
    for (let i = 0; i < _bytes.length; i += 1) {
      buffer.put(_bytes[i], 8);
    }
  };
  return _this;
};
var qrKanji = function(data) {
  const _mode = QRMode.MODE_KANJI;
  const _data = data;
  const stringToBytes2 = qrcode.stringToBytes;
  !function(c, code) {
    const test = stringToBytes2(c);
    if (test.length != 2 || (test[0] << 8 | test[1]) != code) {
      throw "sjis not supported.";
    }
  }("\u53CB", 38726);
  const _bytes = stringToBytes2(data);
  const _this = {};
  _this.getMode = function() {
    return _mode;
  };
  _this.getLength = function(buffer) {
    return ~~(_bytes.length / 2);
  };
  _this.write = function(buffer) {
    const data2 = _bytes;
    let i = 0;
    while (i + 1 < data2.length) {
      let c = (255 & data2[i]) << 8 | 255 & data2[i + 1];
      if (33088 <= c && c <= 40956) {
        c -= 33088;
      } else if (57408 <= c && c <= 60351) {
        c -= 49472;
      } else {
        throw "illegal char at " + (i + 1) + "/" + c;
      }
      c = (c >>> 8 & 255) * 192 + (c & 255);
      buffer.put(c, 13);
      i += 2;
    }
    if (i < data2.length) {
      throw "illegal char at " + (i + 1);
    }
  };
  return _this;
};
var byteArrayOutputStream = function() {
  const _bytes = [];
  const _this = {};
  _this.writeByte = function(b) {
    _bytes.push(b & 255);
  };
  _this.writeShort = function(i) {
    _this.writeByte(i);
    _this.writeByte(i >>> 8);
  };
  _this.writeBytes = function(b, off, len) {
    off = off || 0;
    len = len || b.length;
    for (let i = 0; i < len; i += 1) {
      _this.writeByte(b[i + off]);
    }
  };
  _this.writeString = function(s) {
    for (let i = 0; i < s.length; i += 1) {
      _this.writeByte(s.charCodeAt(i));
    }
  };
  _this.toByteArray = function() {
    return _bytes;
  };
  _this.toString = function() {
    let s = "";
    s += "[";
    for (let i = 0; i < _bytes.length; i += 1) {
      if (i > 0) {
        s += ",";
      }
      s += _bytes[i];
    }
    s += "]";
    return s;
  };
  return _this;
};
var base64EncodeOutputStream = function() {
  let _buffer = 0;
  let _buflen = 0;
  let _length = 0;
  let _base64 = "";
  const _this = {};
  const writeEncoded = function(b) {
    _base64 += String.fromCharCode(encode(b & 63));
  };
  const encode = function(n) {
    if (n < 0) {
      throw "n:" + n;
    } else if (n < 26) {
      return 65 + n;
    } else if (n < 52) {
      return 97 + (n - 26);
    } else if (n < 62) {
      return 48 + (n - 52);
    } else if (n == 62) {
      return 43;
    } else if (n == 63) {
      return 47;
    } else {
      throw "n:" + n;
    }
  };
  _this.writeByte = function(n) {
    _buffer = _buffer << 8 | n & 255;
    _buflen += 8;
    _length += 1;
    while (_buflen >= 6) {
      writeEncoded(_buffer >>> _buflen - 6);
      _buflen -= 6;
    }
  };
  _this.flush = function() {
    if (_buflen > 0) {
      writeEncoded(_buffer << 6 - _buflen);
      _buffer = 0;
      _buflen = 0;
    }
    if (_length % 3 != 0) {
      const padlen = 3 - _length % 3;
      for (let i = 0; i < padlen; i += 1) {
        _base64 += "=";
      }
    }
  };
  _this.toString = function() {
    return _base64;
  };
  return _this;
};
var base64DecodeInputStream = function(str) {
  const _str = str;
  let _pos = 0;
  let _buffer = 0;
  let _buflen = 0;
  const _this = {};
  _this.read = function() {
    while (_buflen < 8) {
      if (_pos >= _str.length) {
        if (_buflen == 0) {
          return -1;
        }
        throw "unexpected end of file./" + _buflen;
      }
      const c = _str.charAt(_pos);
      _pos += 1;
      if (c == "=") {
        _buflen = 0;
        return -1;
      } else if (c.match(/^\s$/)) {
        continue;
      }
      _buffer = _buffer << 6 | decode(c.charCodeAt(0));
      _buflen += 6;
    }
    const n = _buffer >>> _buflen - 8 & 255;
    _buflen -= 8;
    return n;
  };
  const decode = function(c) {
    if (65 <= c && c <= 90) {
      return c - 65;
    } else if (97 <= c && c <= 122) {
      return c - 97 + 26;
    } else if (48 <= c && c <= 57) {
      return c - 48 + 52;
    } else if (c == 43) {
      return 62;
    } else if (c == 47) {
      return 63;
    } else {
      throw "c:" + c;
    }
  };
  return _this;
};
var gifImage = function(width, height) {
  const _width = width;
  const _height = height;
  const _data = new Array(width * height);
  const _this = {};
  _this.setPixel = function(x, y, pixel) {
    _data[y * _width + x] = pixel;
  };
  _this.write = function(out) {
    out.writeString("GIF87a");
    out.writeShort(_width);
    out.writeShort(_height);
    out.writeByte(128);
    out.writeByte(0);
    out.writeByte(0);
    out.writeByte(0);
    out.writeByte(0);
    out.writeByte(0);
    out.writeByte(255);
    out.writeByte(255);
    out.writeByte(255);
    out.writeString(",");
    out.writeShort(0);
    out.writeShort(0);
    out.writeShort(_width);
    out.writeShort(_height);
    out.writeByte(0);
    const lzwMinCodeSize = 2;
    const raster = getLZWRaster(lzwMinCodeSize);
    out.writeByte(lzwMinCodeSize);
    let offset = 0;
    while (raster.length - offset > 255) {
      out.writeByte(255);
      out.writeBytes(raster, offset, 255);
      offset += 255;
    }
    out.writeByte(raster.length - offset);
    out.writeBytes(raster, offset, raster.length - offset);
    out.writeByte(0);
    out.writeString(";");
  };
  const bitOutputStream = function(out) {
    const _out = out;
    let _bitLength = 0;
    let _bitBuffer = 0;
    const _this2 = {};
    _this2.write = function(data, length) {
      if (data >>> length != 0) {
        throw "length over";
      }
      while (_bitLength + length >= 8) {
        _out.writeByte(255 & (data << _bitLength | _bitBuffer));
        length -= 8 - _bitLength;
        data >>>= 8 - _bitLength;
        _bitBuffer = 0;
        _bitLength = 0;
      }
      _bitBuffer = data << _bitLength | _bitBuffer;
      _bitLength = _bitLength + length;
    };
    _this2.flush = function() {
      if (_bitLength > 0) {
        _out.writeByte(_bitBuffer);
      }
    };
    return _this2;
  };
  const getLZWRaster = function(lzwMinCodeSize) {
    const clearCode = 1 << lzwMinCodeSize;
    const endCode = (1 << lzwMinCodeSize) + 1;
    let bitLength = lzwMinCodeSize + 1;
    const table = lzwTable();
    for (let i = 0; i < clearCode; i += 1) {
      table.add(String.fromCharCode(i));
    }
    table.add(String.fromCharCode(clearCode));
    table.add(String.fromCharCode(endCode));
    const byteOut = byteArrayOutputStream();
    const bitOut = bitOutputStream(byteOut);
    bitOut.write(clearCode, bitLength);
    let dataIndex = 0;
    let s = String.fromCharCode(_data[dataIndex]);
    dataIndex += 1;
    while (dataIndex < _data.length) {
      const c = String.fromCharCode(_data[dataIndex]);
      dataIndex += 1;
      if (table.contains(s + c)) {
        s = s + c;
      } else {
        bitOut.write(table.indexOf(s), bitLength);
        if (table.size() < 4095) {
          if (table.size() == 1 << bitLength) {
            bitLength += 1;
          }
          table.add(s + c);
        }
        s = c;
      }
    }
    bitOut.write(table.indexOf(s), bitLength);
    bitOut.write(endCode, bitLength);
    bitOut.flush();
    return byteOut.toByteArray();
  };
  const lzwTable = function() {
    const _map = {};
    let _size = 0;
    const _this2 = {};
    _this2.add = function(key) {
      if (_this2.contains(key)) {
        throw "dup key:" + key;
      }
      _map[key] = _size;
      _size += 1;
    };
    _this2.size = function() {
      return _size;
    };
    _this2.indexOf = function(key) {
      return _map[key];
    };
    _this2.contains = function(key) {
      return typeof _map[key] != "undefined";
    };
    return _this2;
  };
  return _this;
};
var createDataURL = function(width, height, getPixel) {
  const gif = gifImage(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      gif.setPixel(x, y, getPixel(x, y));
    }
  }
  const b = byteArrayOutputStream();
  gif.write(b);
  const base64 = base64EncodeOutputStream();
  const bytes = b.toByteArray();
  for (let i = 0; i < bytes.length; i += 1) {
    base64.writeByte(bytes[i]);
  }
  base64.flush();
  return "data:image/gif;base64," + base64;
};
var stringToBytes = qrcode.stringToBytes;

// web/demo.ts
var statusEl = document.getElementById("status");
var qrBox = document.getElementById("qrbox");
var qrCanvas = document.getElementById("qr");
var linkEl = document.getElementById("link");
var canvas = document.getElementById("view");
var ctx = canvas.getContext("2d");
var params = new URLSearchParams(location.search);
var hash = new URLSearchParams(location.hash.replace(/^#/, ""));
var relayOverride = params.get("relay") ?? void 0;
var secret = sessionStorage.getItem("ping-demo-secret");
if (!secret) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  secret = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  sessionStorage.setItem("ping-demo-secret", secret);
}
var storedId = sessionStorage.getItem("ping-demo-id");
var fragmentPeer = hash.get("j");
var joining = Boolean(fragmentPeer) && fragmentPeer !== storedId;
var env = {
  ROLE: joining ? "join" : "host",
  SECRET: secret,
  ...joining && {
    PEER: fragmentPeer,
    PEER_RELAY: hash.get("r") ?? ""
  },
  ...relayOverride && {
    RELAY: relayOverride
  }
};
var rustLog = globalThis.RUST_LOG;
if (rustLog) env.RUST_LOG = rustLog;
var demo = globalThis.__demo = {
  role: env.ROLE,
  state: "loading",
  path: "none",
  rttUs: 0,
  selfId: storedId,
  peerId: null,
  relay: null,
  joinUrl: null,
  pings: 0,
  remotePings: 0,
  lastRemotePing: null,
  transfers: [],
  overlay: overlayStats,
  shim: stats
};
var t0 = performance.now();
function setStatus(state, text) {
  demo.state = state;
  statusEl.textContent = text;
  console.log(`[demo] t+${Math.round(performance.now() - t0)}ms state=${state}`);
}
var guestSocket = null;
var encoder = new TextEncoder();
var decoder = new TextDecoder();
var GUEST_FROM = {
  tag: "ipv4",
  val: {
    port: 3,
    address: [
      127,
      0,
      0,
      1
    ]
  }
};
function sendToGuest(obj) {
  if (!guestSocket) return;
  pushDatagram(guestSocket, encoder.encode(JSON.stringify(obj)), GUEST_FROM);
}
var upgrade = null;
registerBridge(3, (socket, { data }) => {
  guestSocket = socket;
  if (data.length > 0 && data[0] === 2) {
    receiving?.parts.push(data.slice(1));
    return;
  }
  let msg;
  try {
    msg = JSON.parse(decoder.decode(data));
  } catch {
    return;
  }
  switch (msg.t) {
    case "ready": {
      demo.selfId = msg.id;
      demo.relay = msg.relay;
      if (demo.role === "host") {
        sessionStorage.setItem("ping-demo-id", msg.id);
        const url = new URL(location.href);
        url.hash = `j=${msg.id}&r=${encodeURIComponent(msg.relay)}`;
        demo.joinUrl = url.href;
        history.replaceState(null, "", url.hash);
        showQr(url.href);
        setStatus("waiting", "scan to join");
      } else {
        setStatus("connecting", "joining session\u2026");
      }
      break;
    }
    case "connected": {
      demo.peerId = msg.peer;
      qrBox.style.display = "none";
      setStatus("connected", "connected \xB7 relay");
      upgrade?.close();
      upgrade = beginUpgrade({
        remoteIdHex: msg.peer,
        initiator: demo.role === "host",
        sendSignal: (m) => sendToGuest({
          t: "sig",
          m
        }),
        onStatus: (s) => console.log(`[overlay] ${s}`)
      });
      break;
    }
    case "sig": {
      upgrade?.signal(msg.m);
      break;
    }
    case "ping": {
      demo.remotePings++;
      demo.lastRemotePing = {
        x: msg.x,
        y: msg.y
      };
      ripple(msg.x, msg.y, "#f0f");
      break;
    }
    // --- file transfer events -------------------------------------------
    case "offer": {
      onOffer(msg);
      break;
    }
    case "received": {
      onPeerReceived(msg.hash);
      break;
    }
    case "added": {
      onAdded(msg);
      break;
    }
    case "progress": {
      onProgress(msg);
      break;
    }
    case "file-start": {
      onFileStart(msg);
      break;
    }
    case "file-done": {
      onFileDone(msg);
      break;
    }
    case "file-error": {
      onFileError(msg);
      break;
    }
    case "path": {
      demo.path = msg.path;
      demo.rttUs = msg.rtt_us;
      console.log(`[guest] path=${msg.path} rtt=${msg.rtt_us}us`);
      if (demo.state === "connected" || demo.state === "live") {
        const rtt = msg.rtt_us ? ` \xB7 ${(msg.rtt_us / 1e3).toFixed(1)}ms` : "";
        setStatus("live", `connected \xB7 ${msg.path}${rtt}`);
      }
      break;
    }
    case "overlay": {
      console.log(`[guest] overlay ${msg.state}`);
      break;
    }
    case "closed": {
      demo.peerId = null;
      demo.path = "none";
      upgrade?.close();
      upgrade = null;
      if (demo.role === "host") {
        if (demo.joinUrl) showQr(demo.joinUrl);
        setStatus("closed", "peer left \xB7 scan to rejoin");
      } else {
        setStatus("closed", "peer left \xB7 reconnecting\u2026");
      }
      break;
    }
    case "error": {
      setStatus("error", `error: ${msg.msg}`);
      break;
    }
  }
});
function showQr(url) {
  const qr = qrcode(0, "L");
  qr.addData(url);
  qr.make();
  const n = qr.getModuleCount();
  const scale = Math.max(2, Math.floor(220 / n));
  const size = (n + 8) * scale;
  qrCanvas.width = qrCanvas.height = size;
  const qctx = qrCanvas.getContext("2d");
  qctx.fillStyle = "#fff";
  qctx.fillRect(0, 0, size, size);
  qctx.fillStyle = "#000";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) qctx.fillRect((c + 4) * scale, (r + 4) * scale, scale, scale);
    }
  }
  linkEl.href = url;
  linkEl.textContent = url.length > 60 ? `${url.slice(0, 57)}\u2026` : url;
  qrBox.style.display = "flex";
}
var ripples = [];
function resize() {
  const side = Math.min(window.innerWidth, window.innerHeight) - 16;
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = canvas.style.height = `${side}px`;
  canvas.width = canvas.height = Math.round(side * dpr);
}
window.addEventListener("resize", resize);
resize();
function ripple(x, y, color) {
  ripples.push({
    x,
    y,
    color,
    t0: performance.now()
  });
}
canvas.addEventListener("pointerdown", (ev) => {
  const rect = canvas.getBoundingClientRect();
  const x = (ev.clientX - rect.left) / rect.width;
  const y = (ev.clientY - rect.top) / rect.height;
  demo.pings++;
  ripple(x, y, "#0ff");
  sendToGuest({
    t: "ping",
    x,
    y
  });
});
function frame2(now) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const side = canvas.width;
  for (let i = ripples.length - 1; i >= 0; i--) {
    const r = ripples[i];
    const age = (now - r.t0) / 1e3;
    if (age > 1) {
      ripples.splice(i, 1);
      continue;
    }
    ctx.beginPath();
    ctx.arc(r.x * side, r.y * side, age * side * 0.35 + side * 0.01, 0, 2 * Math.PI);
    ctx.strokeStyle = r.color;
    ctx.globalAlpha = 1 - age;
    ctx.lineWidth = Math.max(2, side * 6e-3) * (1 - age);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  requestAnimationFrame(frame2);
}
requestAnimationFrame(frame2);
var CHUNK = 16 * 1024 - 1;
var MAX_FILE = 64 * 1024 * 1024;
var filesEl = document.getElementById("transfers");
var fileInput = document.getElementById("file");
var sendSeq = 0;
var sends = /* @__PURE__ */ new Map();
var fetches = /* @__PURE__ */ new Map();
var receiving = null;
function addTransfer(dir, name, size) {
  const el = document.createElement("div");
  el.className = "transfer";
  filesEl.appendChild(el);
  const t = {
    dir,
    name,
    size,
    hash: null,
    state: "starting",
    el,
    t0: performance.now()
  };
  demo.transfers.push(t);
  return t;
}
function renderTransfer(t, text, link) {
  const arrow = t.dir === "up" ? "\u2191" : "\u2193";
  const mib = (t.size / (1024 * 1024)).toFixed(1);
  if (link) {
    t.el.textContent = "";
    const a = document.createElement("a");
    a.href = link;
    a.download = t.name;
    a.textContent = `${arrow} ${t.name} \xB7 ${mib} MiB \xB7 save`;
    t.el.appendChild(a);
  } else {
    t.el.textContent = `${arrow} ${t.name} \xB7 ${text}`;
  }
}
async function sendFile(file) {
  if (!guestSocket || !demo.peerId) return;
  if (file.size === 0 || file.size > MAX_FILE) {
    const t2 = addTransfer("up", file.name, file.size);
    t2.state = "error";
    renderTransfer(t2, file.size === 0 ? "empty" : "too big (max 64 MiB)");
    return;
  }
  const id = sendSeq++;
  const t = addTransfer("up", file.name, file.size);
  sends.set(id, t);
  renderTransfer(t, "reading\u2026");
  const bytes = new Uint8Array(await file.arrayBuffer());
  sendToGuest({
    t: "send",
    id,
    name: file.name,
    size: file.size
  });
  for (let off = 0; off < bytes.length; off += CHUNK) {
    const chunk = bytes.subarray(off, Math.min(off + CHUNK, bytes.length));
    const frame3 = new Uint8Array(1 + chunk.length);
    frame3[0] = 1;
    frame3.set(chunk, 1);
    pushDatagram(guestSocket, frame3, GUEST_FROM);
    if (off / CHUNK % 64 === 63) {
      renderTransfer(t, `hashing ${Math.round(off / bytes.length * 100)}%`);
      await new Promise((r) => setTimeout(r));
    }
  }
  renderTransfer(t, "hashing\u2026");
}
function onAdded(msg) {
  const t = sends.get(msg.id);
  if (!t) return;
  t.hash = msg.hash;
  t.state = "offered";
  renderTransfer(t, "sent \xB7 waiting for peer");
  sendToGuest({
    t: "offer",
    hash: msg.hash,
    name: t.name,
    size: t.size
  });
}
function onPeerReceived(hash2) {
  for (const t of sends.values()) {
    if (t.hash === hash2) {
      t.state = "done";
      const secs = (performance.now() - t.t0) / 1e3;
      renderTransfer(t, `delivered \xB7 ${(t.size / (1024 * 1024) / secs).toFixed(1)} MiB/s`);
      console.log(`[file] up ${t.name} delivered in ${secs.toFixed(1)}s`);
    }
  }
}
function onOffer(msg) {
  const t = addTransfer("down", msg.name, msg.size);
  t.hash = msg.hash;
  t.state = "fetching";
  fetches.set(msg.hash, t);
  renderTransfer(t, "fetching\u2026");
  sendToGuest({
    t: "fetch",
    hash: msg.hash,
    size: msg.size
  });
}
function onProgress(msg) {
  const t = fetches.get(msg.hash);
  if (t) renderTransfer(t, `fetching ${Math.round(msg.done / msg.total * 100)}%`);
}
function onFileStart(msg) {
  const t = fetches.get(msg.hash);
  if (!t) return;
  receiving = t;
  t.parts = [];
}
function onFileDone(msg) {
  const t = fetches.get(msg.hash);
  if (!t || receiving !== t) return;
  receiving = null;
  const blob = new Blob(t.parts, {
    type: "application/octet-stream"
  });
  t.parts = null;
  t.bytes = blob.size;
  t.state = "done";
  const secs = (performance.now() - t.t0) / 1e3;
  renderTransfer(t, "", URL.createObjectURL(blob));
  sendToGuest({
    t: "received",
    hash: msg.hash
  });
  console.log(`[file] down ${t.name} ${blob.size} bytes in ${secs.toFixed(1)}s = ${(blob.size / (1024 * 1024) / secs).toFixed(1)} MiB/s`);
}
function onFileError(msg) {
  console.error(`[file] error: ${msg.msg}`);
  if (receiving) {
    receiving.state = "error";
    renderTransfer(receiving, `failed: ${msg.msg}`);
    receiving = null;
  }
}
document.getElementById("send-file").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => {
  for (const file of fileInput.files ?? []) await sendFile(file);
  fileInput.value = "";
});
window.addEventListener("dragover", (ev) => ev.preventDefault());
window.addEventListener("drop", async (ev) => {
  ev.preventDefault();
  for (const file of ev.dataTransfer?.files ?? []) await sendFile(file);
});
window.addEventListener("pagehide", () => {
  if (guestSocket) pushDatagram(guestSocket, new Uint8Array(0), GUEST_FROM);
});
window.addEventListener("pageshow", (ev) => {
  if (ev.persisted) location.reload();
});
var debugBtn = document.getElementById("debug-toggle");
var debugEl = document.getElementById("debug");
var debugTimer = null;
function renderDebug() {
  const o = demo.overlay;
  const s = demo.shim;
  debugEl.textContent = [
    `role      ${demo.role}`,
    `state     ${demo.state}`,
    `self      ${demo.selfId ?? "\u2026"}`,
    `peer      ${demo.peerId ?? "\u2014"}`,
    `relay     ${demo.relay ?? "\u2026"}`,
    `path      ${demo.path}${demo.rttUs ? ` (${(demo.rttUs / 1e3).toFixed(1)}ms)` : ""}`,
    `channel   in=${o.in} out=${o.out} dropped=${o.droppedWhileConnecting}`,
    `datagrams in=${s.datagramsIn} out=${s.datagramsOut}`,
    `pings     sent=${demo.pings} received=${demo.remotePings}`
  ].join("\n");
}
debugBtn.addEventListener("click", () => {
  const visible = debugEl.style.display === "block";
  debugEl.style.display = visible ? "none" : "block";
  if (debugTimer) {
    clearInterval(debugTimer);
    debugTimer = null;
  }
  if (!visible) {
    renderDebug();
    debugTimer = setInterval(renderDebug, 1e3);
  }
});
setStatus("loading", "loading component\u2026");
try {
  const [componentBytes, envelopeText] = await Promise.all([
    fetch("./ping-demo.component.wasm").then(async (r) => {
      if (!r.ok) throw new Error(`GET ping-demo.component.wasm: ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    }),
    fetch("./ping-demo.plan.json").then((r) => {
      if (!r.ok) throw new Error(`GET ping-demo.plan.json: ${r.status}`);
      return r.text();
    })
  ]);
  const artifacts = artifactsFrom(envelopeText, componentBytes);
  setStatus("starting", "starting endpoint\u2026");
  runGuest(artifacts, guestImports({
    args: [
      "ping-demo-guest"
    ],
    env
  })).catch((err) => setStatus("error", `guest failed: ${err}`));
} catch (err) {
  const jspi = typeof WebAssembly.Suspending === "function";
  setStatus("error", jspi ? `failed to load: ${err}` : "this browser has no WebAssembly JSPI \u2014 use Chrome/Edge (desktop or Android)");
}
