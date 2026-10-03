import type { AvatarSceneOptions } from "./scene";
import { AVATAR_SCENE_SCRIPT } from "./scene-bundle";

function safeJson(value: unknown) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function avatarUpdateScript(options: Partial<AvatarSceneOptions>) {
  return `window.__OKAMI_AVATAR__?.update(${safeJson(options)}); true;`;
}

/** No URL, API credentials, filesystem access or fetched scripts are present in this document. */
export function avatarNativeDocument(options: AvatarSceneOptions) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'"><style>html,body,#avatar{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}body{-webkit-user-select:none;user-select:none}</style></head><body><div id="avatar"></div><script>window.__OKAMI_AVATAR_INITIAL__=${safeJson(options)};</script><script>${AVATAR_SCENE_SCRIPT.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
}
