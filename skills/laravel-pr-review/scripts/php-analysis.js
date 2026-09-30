"use strict";

const path = require("node:path");

const SCALAR_FIELDS = new Set([
  "id", "uuid", "name", "email", "title", "status", "slug", "created_at", "updated_at",
  "deleted_at", "tenant_id", "type", "amount", "total", "currency", "active", "enabled",
]);
const DB_METHODS = new Set(["query", "where", "find", "all", "first", "get", "count", "exists", "value", "sum", "avg"]);
const BOUND_METHODS = new Set(["limit", "take", "paginate", "simplepaginate", "cursorpaginate", "chunk", "chunkbyid", "cursor", "lazy"]);
const QUERY_CHAIN_METHODS = new Set(["query", "table", "from", "select", "where", "with", "join", "orderby", "groupby"]);
const LOOP_KEYWORDS = new Set(["foreach", "for", "while"]);

function tokenizePhp(source) {
  const tokens = [];
  let index = 0;
  let line = 1;
  let inPhp = !/<\?(?:php\b|=)/i.test(source);
  const advance = (text) => { line += (text.match(/\n/g) || []).length; index += text.length; };

  while (index < source.length) {
    const rest = source.slice(index);
    const char = source[index];
    if (!inPhp) {
      const open = rest.match(/<\?(?:php\b|=)/i);
      if (!open) break;
      advance(rest.slice(0, open.index + open[0].length));
      inPhp = true;
      continue;
    }
    if (rest.startsWith("?>")) {
      advance("?>");
      inPhp = false;
      continue;
    }
    if (/\s/.test(char)) {
      advance(char);
      continue;
    }
    if (/^<\?php\b/i.test(rest)) { advance(rest.match(/^<\?php\b/i)[0]); continue; }
    if (rest.startsWith("<?=")) { advance("<?="); continue; }
    if (rest.startsWith("//") || (char === "#" && !rest.startsWith("#["))) {
      const end = source.indexOf("\n", index);
      advance(source.slice(index, end < 0 ? source.length : end));
      continue;
    }
    if (rest.startsWith("/*")) {
      const end = source.indexOf("*/", index + 2);
      advance(source.slice(index, end < 0 ? source.length : end + 2));
      continue;
    }
    if (rest.startsWith("<<<")) {
      const headerEnd = source.indexOf("\n", index);
      if (headerEnd >= 0) {
        const header = source.slice(index, headerEnd);
        const marker = header.match(/^<<<\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*;?\s*$/);
        if (marker) {
          const closing = new RegExp(`^\\s*${marker[1]}[),;]*\\s*$`, "m");
          const match = closing.exec(source.slice(headerEnd + 1));
          const end = match ? headerEnd + 1 + match.index + match[0].length : source.length;
          const text = source.slice(index, end);
          const bodyStart = text.indexOf("\n") + 1;
          const containsSelectStar = /^\s*select\s+\*\s+from\b/im.test(text.slice(bodyStart));
          tokens.push({ type: "string", value: "", containsSelectStar, line });
          advance(text);
          continue;
        }
      }
    }
    if (char === "'" || char === '"' || char === "`") {
      const start = index;
      const tokenLine = line;
      let escaped = false;
      index++;
      while (index < source.length) {
        const current = source[index++];
        if (current === "\n") line++;
        if (escaped) escaped = false;
        else if (current === "\\") escaped = true;
        else if (current === char) break;
      }
      tokens.push({ type: "string", value: source.slice(start + 1, Math.max(start + 1, index - 1)), line: tokenLine });
      continue;
    }
    if (char === "$" && /[A-Za-z_\u0080-\uffff]/.test(source[index + 1] || "")) {
      const match = source.slice(index).match(/^\$[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*/);
      tokens.push({ type: "variable", value: match[0], line });
      advance(match[0]);
      continue;
    }
    if (/[A-Za-z_\u0080-\uffff]/.test(char)) {
      const match = rest.match(/^[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*/);
      tokens.push({ type: "identifier", value: match[0], line });
      advance(match[0]);
      continue;
    }
    if (/\d/.test(char)) {
      const match = rest.match(/^\d+(?:\.\d+)?/);
      tokens.push({ type: "number", value: match[0], line });
      advance(match[0]);
      continue;
    }
    const operator = ["?->", "...", "::", "->", "=>", "??=", "??", "&&", "||", "===", "!==", "==", "!=", ">=", "<=", "++", "--"]
      .find((candidate) => rest.startsWith(candidate));
    const value = operator || char;
    tokens.push({ type: "punct", value, line });
    advance(value);
  }
  return tokens;
}

function matchingBraces(tokens) {
  const pairs = new Map();
  const stack = [];
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].value === "{") stack.push(index);
    else if (tokens[index].value === "}" && stack.length) {
      const open = stack.pop();
      pairs.set(open, index);
    }
  }
  return pairs;
}

function loopBodies(tokens, pairs) {
  const bodies = [];
  for (let index = 0; index < tokens.length; index++) {
    if (!LOOP_KEYWORDS.has(tokens[index].value.toLowerCase())) continue;
    let cursor = index + 1;
    if (tokens[cursor]?.value !== "(") continue;
    let parens = 0;
    for (; cursor < tokens.length; cursor++) {
      if (tokens[cursor].value === "(") parens++;
      else if (tokens[cursor].value === ")" && --parens === 0) { cursor++; break; }
    }
    if (tokens[cursor]?.value === "{") {
      bodies.push({ start: cursor + 1, end: pairs.get(cursor) ?? cursor, line: tokens[index].line });
    } else {
      let end = cursor;
      while (end < tokens.length && tokens[end].value !== ";" && tokens[end].value !== "}") end++;
      bodies.push({ start: cursor, end, line: tokens[index].line });
    }
  }
  return bodies;
}

function callName(tokens, index) {
  const token = tokens[index];
  if (!token || token.type !== "identifier") return null;
  if ((tokens[index - 1]?.value === "->" || tokens[index - 1]?.value === "?->") && tokens[index + 1]?.value === "(") {
    return token.value.toLowerCase();
  }
  if (tokens[index - 1]?.value === "::" && tokens[index + 1]?.value === "(") return token.value.toLowerCase();
  return null;
}

function hasDatabaseCall(tokens) {
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].value.toLowerCase() === "db" && tokens[index + 1]?.value === "::") return true;
    const name = callName(tokens, index);
    if (name && DB_METHODS.has(name)) return true;
    if (tokens[index].value === "::" && DB_METHODS.has(tokens[index + 1]?.value.toLowerCase())) return true;
  }
  return false;
}

function addFinding(findings, root, file, line, rule, confidence, evidence, recommendation) {
  const location = `${path.relative(root, file).split(path.sep).join("/").replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 240)}:${line}`;
  findings.push({ rule, severity: "review", confidence, source: "static", location, evidence, recommendation });
}

function methodCallBounds(tokens, methodIndex) {
  if (tokens[methodIndex + 1]?.value !== "(") return methodIndex;
  let depth = 0;
  for (let index = methodIndex + 1; index < tokens.length; index++) {
    if (tokens[index].value === "(") depth++;
    else if (tokens[index].value === ")" && --depth === 0) return index;
  }
  return methodIndex;
}

function inspectPhpSource(source, root, file) {
  const tokens = tokenizePhp(source);
  const findings = [];
  const pairs = matchingBraces(tokens);
  const loops = loopBodies(tokens, pairs);

  for (const loop of loops) {
    const body = tokens.slice(loop.start, loop.end);
    if (hasDatabaseCall(body)) {
      addFinding(findings, root, file, loop.line, "DATABASE_CALL_IN_LOOP", "medium",
        "A database-shaped call appears inside a loop body; confirm whether it executes once per item.",
        "Move repeated reads to a bounded batch query or preload only the needed relations, then compare query traces on an isolated dataset.");
    }
    const relation = body.find((token, index) => token.type === "variable" &&
      ["->", "?->"].includes(body[index + 1]?.value) && body[index + 2]?.type === "identifier" &&
      body[index + 3]?.value !== "(" && !SCALAR_FIELDS.has(body[index + 2].value.toLowerCase()));
    if (relation) {
      addFinding(findings, root, file, loop.line, "RELATION_ACCESS_IN_LOOP", "low",
        "A non-scalar property read appears inside a loop; it could be an Eloquent relation that lazy-loads.",
        "Check the model definition and serialization path. If the property is a relation that queries per item, eager-load it and assert query counts in an isolated test.");
    }
  }

  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].type === "string" && (tokens[index].containsSelectStar || /^\s*select\s+\*\s+from\b/i.test(tokens[index].value))) {
      addFinding(findings, root, file, tokens[index].line, "RAW_SELECT_STAR", "medium",
        "A string literal contains a raw SELECT * query.",
        "List only the columns required by this path and verify the result shape and authorization behavior remain unchanged.");
    }

    const method = callName(tokens, index);
    if (method === "get") {
      let start = index - 1;
      while (start >= 0 && ![";", "{", "}"].includes(tokens[start].value)) start--;
      const expression = tokens.slice(start + 1, index);
      const queryShaped = expression.some((token, offset) =>
        QUERY_CHAIN_METHODS.has(token.value.toLowerCase()) || token.value.toLowerCase() === "db" && expression[offset + 1]?.value === "::" ||
        token.type === "variable" && /\$(?:[A-Za-z0-9_]*query|[A-Za-z0-9_]*builder|[A-Za-z0-9_]*eloquent|db)$/i.test(token.value));
      if (queryShaped && !expression.some((token) => BOUND_METHODS.has(token.value.toLowerCase()))) {
        addFinding(findings, root, file, tokens[index].line, "COLLECTION_GET_WITHOUT_VISIBLE_BOUND", "low",
          "A get() call has no page, limit, or streaming method in the surrounding expression.",
          "Verify the maximum result size. Select required fields and use a bounded page or chunked processing when compatible with the caller.");
      }
    }

    if ((method === "paginate" || method === "simplepaginate") && tokens[index + 1]?.value === "(") {
      const close = methodCallBounds(tokens, index);
      const args = tokens.slice(index + 2, close);
      const requestInput = args.some((token, offset) => token.value.toLowerCase() === "request" && args[offset + 1]?.value === "(" ||
        token.type === "variable" && token.value.toLowerCase() === "$request" && ["->", "?->"].includes(args[offset + 1]?.value));
      if (requestInput) {
        addFinding(findings, root, file, tokens[index].line, "UNBOUNDED_PAGE_SIZE_INPUT", "medium",
          "Pagination size appears to be derived directly from request input.",
          "Clamp the requested size to a documented server-side maximum and test invalid, negative, and unusually large values.");
      }
    }

    if (method === "count") {
      const close = methodCallBounds(tokens, index);
      if ([">", "!=", "!==", "==", "===", "<", "<=", ">="].includes(tokens[close + 1]?.value) &&
          (tokens[close + 2]?.value === "0" || tokens[close + 2]?.value === "1")) {
        addFinding(findings, root, file, tokens[index].line, "COUNT_USED_AS_BOOLEAN", "low",
          "The result of count() is compared with a boolean-like numeric constant.",
          "If only existence matters, verify semantics and consider an existence query rather than counting all matching rows.");
      }
    }
  }
  return findings;
}

module.exports = { inspectPhpSource, tokenizePhp };
