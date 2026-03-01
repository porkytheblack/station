/**
 * Zod schema serializer and metadata types for station API.
 * Introspects Zod schema internals to produce JSON-serializable descriptions.
 */

// ── Types ──

export interface SchemaField {
  type: string;
  required: boolean;
  properties?: Record<string, SchemaField>;
  items?: SchemaField;
  values?: string[];
}

export interface SignalMeta {
  name: string;
  filePath: string;
  inputSchema: SchemaField | null;
  outputSchema: SchemaField | null;
  interval: string | null;
  timeout: number;
  maxAttempts: number;
  maxConcurrency: number | null;
  hasSteps: boolean;
  stepNames: string[];
}

export interface BroadcastMeta {
  name: string;
  filePath: string;
  nodes: Array<{ name: string; signalName: string; dependsOn: string[] }>;
  failurePolicy: string;
  timeout: number | null;
  interval: string | null;
}

// ── Zod Schema Serializer ──

/**
 * Resolves the type identifier and def from a Zod schema.
 * Supports both Zod v3 (_def.typeName) and Zod v4 (_zod.def.type).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function zodDef(schema: any): { type: string; def: any } | null {
  if (schema?._zod?.def?.type) {
    return { type: schema._zod.def.type, def: schema._zod.def };
  }
  if (schema?._def?.typeName) {
    return { type: schema._def.typeName, def: schema._def };
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function serializeZodSchema(schema: any): SchemaField {
  const z = zodDef(schema);
  if (!z) return { type: "unknown", required: true };

  const { type, def } = z;

  switch (type) {
    case "object":
    case "ZodObject": {
      const shape = typeof def.shape === "function" ? def.shape() : def.shape;
      const properties: Record<string, SchemaField> = {};
      if (shape && typeof shape === "object") {
        for (const [key, value] of Object.entries(shape)) {
          properties[key] = serializeZodSchema(value);
        }
      }
      return { type: "object", required: true, properties };
    }

    case "string":
    case "ZodString":
      return { type: "string", required: true };

    case "number":
    case "ZodNumber":
      return { type: "number", required: true };

    case "boolean":
    case "ZodBoolean":
      return { type: "boolean", required: true };

    case "array":
    case "ZodArray":
      return {
        type: "array",
        required: true,
        items: (def.element ?? def.type) ? serializeZodSchema(def.element ?? def.type) : undefined,
      };

    case "optional":
    case "ZodOptional":
      return { ...serializeZodSchema(def.innerType), required: false };

    case "nullable":
    case "ZodNullable": {
      const inner = serializeZodSchema(def.innerType);
      return { ...inner, type: inner.type + " | null" };
    }

    case "default":
    case "ZodDefault":
      return { ...serializeZodSchema(def.innerType), required: false };

    case "enum":
    case "ZodEnum": {
      // v4: def.entries is {a:'a', b:'b'}; v3: def.values is string[]
      let vals: string[] | undefined;
      if (def.entries && typeof def.entries === "object") {
        vals = Object.values(def.entries) as string[];
      } else if (Array.isArray(def.values)) {
        vals = def.values as string[];
      }
      return { type: "enum", required: true, values: vals };
    }

    case "literal":
    case "ZodLiteral": {
      // v4: def.values is [value]; v3: def.value
      const val = Array.isArray(def.values) ? def.values[0] : def.value;
      return { type: `"${String(val)}"`, required: true };
    }

    case "union":
    case "ZodUnion": {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const opts = (def.options as any[])?.map((o: any) => serializeZodSchema(o).type);
      return { type: opts?.join(" | ") ?? "unknown", required: true };
    }

    case "record":
    case "ZodRecord":
      return { type: "record", required: true };

    case "any":
    case "ZodAny":
      return { type: "any", required: true };

    case "void":
    case "undefined":
    case "ZodVoid":
    case "ZodUndefined":
      return { type: "void", required: true };

    default:
      return { type: "unknown", required: true };
  }
}

// ── Template Generator ──

export function generateTemplate(field: SchemaField): unknown {
  switch (field.type) {
    case "object":
      if (field.properties) {
        const obj: Record<string, unknown> = {};
        for (const [key, f] of Object.entries(field.properties)) {
          obj[key] = generateTemplate(f);
        }
        return obj;
      }
      return {};
    case "string":
      return "";
    case "number":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "enum":
      return field.values?.[0] ?? "";
    default:
      return null;
  }
}
