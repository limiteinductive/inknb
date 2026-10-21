import stylesheet from "./scrollbars.css?raw";

export function scrollbarTheme() {
  const computed = getComputedStyle(document.documentElement);
  return {
    stylesheet,
    appearance: document.documentElement.dataset.theme,
    tokens: {
      ...Object.fromEntries(["--paper", "--surface", "--ink", "--muted", "--faint", "--line", "--line-soft", "--accent", "--selection", "--writing-font", "--interface-font", "--writing-size", "--suggestion", "--danger"].map((name) => [name, computed.getPropertyValue(name)])),
      "--scrollbar-thumb": computed.getPropertyValue("--scrollbar-thumb"),
      "--scrollbar-thumb-hover": computed.getPropertyValue(
        "--scrollbar-thumb-hover",
      ),
    },
  };
}
