import { readFileSync, readdirSync } from "node:fs";
import { parse } from "@babel/parser";
import traverse from "@babel/traverse";
import postcss from "postcss";

const root = new URL("../", import.meta.url);
const problems = [];
const panelClasses = new Set();
const files = readdirSync(new URL("src", root), { recursive: true }).map(
  String,
);

for (const file of files.filter((file) => file.endsWith(".tsx"))) {
  const filename = `src/${file}`;
  const source = parse(readFileSync(new URL(filename, root), "utf8"), {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
  });
  traverse(source, {
    JSXOpeningElement(location) {
      const node = location.node;
      const name = node.name.type === "JSXIdentifier" ? node.name.name : "";
      if (name === "select")
        problems.push(`${filename}: use the shared menu surface for application choices.`);
      const attributes = node.attributes.filter(
        (attribute) => attribute.type === "JSXAttribute",
      );
      if (["PanelPopover", "PanelBody"].includes(name)) {
        const className = attributes.find(
          (attribute) => attribute.name.name === "className",
        );
        if (className?.value?.type === "StringLiteral")
          for (const value of className.value.value.split(/\s+/))
            panelClasses.add(value);
      }
      if (name === "Dialog" && filename !== "src/PanelPopover.tsx") {
        const popover = location.findParent(
          (parent) =>
            parent.isJSXElement() &&
            parent.node.openingElement.name.type === "JSXIdentifier" &&
            ["PanelPopover", "Popover"].includes(
              parent.node.openingElement.name.name,
            ),
        );
        if (popover)
          problems.push(
            `${filename}: use PanelPopover's dialog instead of a nested Dialog.`,
          );
      }
      for (const attribute of attributes) {
        if (
          attribute.name.name !== "className" ||
          attribute.value?.type !== "StringLiteral"
        )
          continue;
        if (
          /\bpanel-(?:heading|surface|body|empty|actions)\b/.test(
            attribute.value.value,
          ) &&
          filename !== "src/PanelPopover.tsx"
        )
          problems.push(
            `${filename}: shared panel structure belongs to PanelPopover.tsx.`,
          );
      }
    },
  });
}

for (const file of files.filter((file) => file.endsWith(".css"))) {
  const filename = `src/${file}`;
  const stylesheet = postcss.parse(
    readFileSync(new URL(filename, root), "utf8"),
    { from: filename },
  );
  stylesheet.walkRules((rule) => {
    const selectors = rule.selectors;
    if (
      filename !== "src/panel.css" &&
      selectors.some((selector) =>
        /\.panel-(?:heading|surface|body|empty|actions|filters)\b/.test(
          selector,
        ),
      )
    )
      problems.push(
        `${filename}: shared panel styles belong to panel.css: ${rule.selector}.`,
      );
    const component = selectors.some((selector) =>
      [...panelClasses].some((className) => selector === `.${className}`),
    );
    rule.walkDecls((declaration) => {
      const property = declaration.prop;
      const value = declaration.value;
      const metric =
        /^(?:(?:min-|max-)?width|padding(?:-.+)?|margin(?:-.+)?|font(?:-.+)?|line-height|border-radius|box-shadow|background(?:-.+)?)$/.test(
          property,
        );
      if (component && (metric || /^(?:color|border(?:-.+)?)$/.test(property)))
        problems.push(
          `${filename}:${declaration.source.start.line}: ${rule.selector} cannot override shared ${property}.`,
        );
      if (
        filename !== "src/tokens.css" &&
        filename !== "src/panel.css" &&
        property.startsWith("--panel-")
      )
        problems.push(
          `${filename}:${declaration.source.start.line}: panel tokens belong to the shared design system.`,
        );
      if (
        ["src/panel.css", "src/decisions.css"].includes(filename) &&
        metric &&
        /\d+(?:px|rem|em)\b/.test(value)
      )
        problems.push(
          `${filename}:${declaration.source.start.line}: use a design token for ${property}: ${value}.`,
        );
    });
  });
}

if (problems.length) {
  process.stderr.write(problems.join("\n") + "\n");
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Design contracts pass: ${panelClasses.size} panel and body layouts use the shared structure.\n`,
  );
}
