"use client";

import { useState, useEffect } from "react";

interface SchemaField {
  type: string;
  required: boolean;
  properties?: Record<string, SchemaField>;
  items?: SchemaField;
  values?: string[];
}

interface SchemaFormProps {
  schema: SchemaField | null;
  value: string;
  onChange: (v: string) => void;
}

function generateTemplate(field: SchemaField): unknown {
  switch (field.type) {
    case "string":
      return "";
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "enum":
      if (field.values && field.values.length > 0) {
        return field.values[0];
      }
      return "";
    case "object": {
      if (!field.properties) return {};
      const obj: Record<string, unknown> = {};
      for (const [key, childField] of Object.entries(field.properties)) {
        obj[key] = generateTemplate(childField);
      }
      return obj;
    }
    default:
      return null;
  }
}

function SchemaReference({ schema }: { schema: SchemaField }) {
  if (schema.type !== "object" || !schema.properties) return null;

  const entries = Object.entries(schema.properties);
  if (entries.length === 0) return null;

  return (
    <div className="schema-ref">
      <div className="schema-ref-title">Expected Input</div>
      {entries.map(([name, field]) => (
        <div key={name} className="schema-field">
          <span className="schema-field-name">{name}</span>
          <span
            className={`schema-field-type${!field.required ? " schema-field-type--optional" : ""}`}
          >
            {field.type}
          </span>
        </div>
      ))}
    </div>
  );
}

export function SchemaForm({ schema, value, onChange }: SchemaFormProps) {
  const [parseError, setParseError] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (initialized) return;
    if (schema && value === "{}") {
      const template = generateTemplate(schema);
      const templateStr = JSON.stringify(template, null, 2);
      if (templateStr !== "{}") {
        onChange(templateStr);
      }
    }
    setInitialized(true);
  }, [schema, value, onChange, initialized]);

  function handleChange(newValue: string) {
    onChange(newValue);
    if (newValue.trim() === "") {
      setParseError(null);
      return;
    }
    try {
      JSON.parse(newValue);
      setParseError(null);
    } catch (err: unknown) {
      if (err instanceof SyntaxError) {
        setParseError(err.message);
      } else {
        setParseError("Invalid JSON");
      }
    }
  }

  return (
    <div>
      {schema && schema.type === "object" && schema.properties && (
        <SchemaReference schema={schema} />
      )}
      <textarea
        className="input-textarea"
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        rows={6}
        spellCheck={false}
        placeholder="{}"
      />
      {parseError && <div className="json-parse-error">{parseError}</div>}
    </div>
  );
}
