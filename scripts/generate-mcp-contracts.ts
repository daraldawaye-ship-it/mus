import ts from "typescript";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { z } from "zod";
const root = resolve("apps/api/src");
const contracts: Record<string, unknown> = {};
for (const file of await readdir(root)) {
  if ((!/^routes-/.test(file) && file!=="memoFeatureRuleRoutes.ts") || /auth|setup|media|chatgpt/.test(file)) continue;
  const source = ts.createSourceFile(
    file,
    await readFile(resolve(root, file), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const imports = new Map<string, { path: string; name: string }>();
  for (const node of source.statements)
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings))
        for (const el of bindings.elements)
          imports.set(el.name.text, {
            path: node.moduleSpecifier.text,
            name: el.propertyName?.text ?? el.name.text,
          });
    }
  const variables = new Map<string, ts.Expression>();
  const collect = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer)
      variables.set(n.name.text, n.initializer);
    ts.forEachChild(n, collect);
  };
  collect(source);
  const literal = (n: ts.Node | undefined, depth = 0): string | undefined => {
    if (!n || depth > 8) return;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))
      return n.text;
    if (ts.isIdentifier(n)) return literal(variables.get(n.text), depth + 1);
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const a = literal(n.left, depth + 1),
        b = literal(n.right, depth + 1);
      if (a !== undefined && b !== undefined) return a + b;
    }
    if (ts.isTemplateExpression(n)) {
      let value = n.head.text;
      for (const span of n.templateSpans) {
        const v = literal(span.expression, depth + 1);
        if (v === undefined) return;
        value += v + span.literal.text;
      }
      return value;
    }
  };
  async function visit(node: ts.Node): Promise<void> {
    if (
      ts.isForOfStatement(node) &&
      ts.isVariableDeclarationList(node.initializer)
    ) {
      const name = node.initializer.declarations[0]?.name;
      const expr = ts.isAsExpression(node.expression)
        ? node.expression.expression
        : node.expression;
      if (name && ts.isIdentifier(name) && ts.isArrayLiteralExpression(expr)) {
        const old = variables.get(name.text);
        for (const value of expr.elements) {
          variables.set(name.text, value);
          await visit(node.statement);
        }
        if (old) variables.set(name.text, old);
        else variables.delete(name.text);
        return;
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(source) === "router" &&
      ["get", "post", "patch", "put", "delete"].includes(
        node.expression.name.text,
      ) &&
      literal(node.arguments[0]) !== undefined
    ) {
      const method = node.expression.name.text.toUpperCase(),
        path = literal(node.arguments[0])!;
      const query = new Set<string>();
      let bodyName: string | undefined;
      let bodySchemaSource: string | undefined;
      const scan = (n: ts.Node) => {
        if (
          ts.isPropertyAccessExpression(n) &&
          n.expression.getText(source) === "req.query"
        )
          query.add(n.name.text);
        if (
          ts.isCallExpression(n) &&
          n.expression.getText(source) === "parse" &&
          n.arguments[1]?.getText(source) === "req.body" &&
          n.arguments[0]
        ) {
          if (ts.isIdentifier(n.arguments[0])) bodyName = n.arguments[0].text;
          else bodySchemaSource = n.arguments[0].getText(source);
        }
        ts.forEachChild(n, scan);
      };
      scan(node);
      const imported = bodyName && imports.get(bodyName);
      let bodySchema: unknown;
      if (bodyName) {
        const mod = await import(
          pathToFileURL(resolve(root, imported ? imported.path : file)).href
        );
        const schema = imported
          ? mod[imported.name]
          : mod.mcpBodySchemas?.[bodyName];
        if (schema instanceof z.ZodType) {
          try {
            bodySchema = z.toJSONSchema(schema, {
              io: "input",
              unrepresentable: "any",
            });
          } catch {}
        }
      }
      contracts[method + " " + path] = {
        queryFields: [...query],
        ...(bodyName ? { bodyContract: bodyName } : {}),
        ...(bodySchema ? { bodySchema } : {}),
        ...(bodySchemaSource ? { bodySchemaSource } : {}),
        source: file,
      };
    }
    for (const child of node.getChildren(source)) await visit(child);
  }
  await visit(source);
}
await writeFile(
  resolve(root, "mcp-contracts.json"),
  JSON.stringify(contracts, null, 2) + "\n",
);
console.log(Object.keys(contracts).length + " route contracts generated");
