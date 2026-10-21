declare module "*.css";
declare module "*?url" {
  const url: string;
  export default url;
}
declare module "*?raw" {
  const source: string;
  export default source;
}
declare const __INKNB_BUILD__: string;
