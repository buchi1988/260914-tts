// Minimal typing for the subset of node:buffer this Worker uses.
// Available at runtime via the `nodejs_compat` compatibility flag.
declare module "node:buffer" {
  export const Buffer: {
    from(data: string, encoding: "base64"): Uint8Array;
  };
}
