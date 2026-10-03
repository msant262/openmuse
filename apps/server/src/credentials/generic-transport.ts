import { request as httpsRequest } from "node:https";
import type { validatePublicUrl } from "../../../worker/src/network.ts";
import { AppError } from "../errors.ts";

export type CredentialTarget = Awaited<ReturnType<typeof validatePublicUrl>>;
export type CredentialTransportInput = {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
};
export type CredentialTransportResponse = { status: number; contentType: string; body: string };
export type CredentialTransport = (
  target: CredentialTarget,
  input: CredentialTransportInput,
) => Promise<CredentialTransportResponse>;

/** Auth is injected only after DNS validation. The connection is pinned to that
 * public address; redirects, cookies and ambient proxy credentials are never used. */
export const requestCredentialEndpoint: CredentialTransport = (target, input) =>
  new Promise((resolve, reject) => {
    const outgoing = httpsRequest(
      target.url,
      {
        method: input.method,
        signal: input.signal,
        agent: false,
        headers: {
          "User-Agent": "OkamiBot/1.0",
          Accept: "application/json,text/plain;q=0.9",
          "Accept-Encoding": "identity",
          ...input.headers,
        },
        lookup: (_host, options, callback) => {
          if (options.all) callback(null, [{ address: target.address, family: target.family }]);
          else callback(null, target.address, target.family);
        },
      },
      (incoming) => {
        const status = incoming.statusCode ?? 502;
        const contentType = String(incoming.headers["content-type"] ?? "text/plain");
        if (status >= 300 && status < 400) {
          incoming.destroy();
          reject(
            new AppError(
              "The service redirected the request. Credentials were not forwarded.",
              502,
              "CREDENTIAL_REDIRECT_BLOCKED",
            ),
          );
          return;
        }
        if (
          Number(incoming.headers["content-length"]) > 1024 * 1024 ||
          (incoming.headers["content-encoding"] &&
            incoming.headers["content-encoding"] !== "identity")
        ) {
          incoming.destroy();
          reject(
            new AppError(
              "The service returned an unsupported or oversized response.",
              502,
              "CREDENTIAL_RESPONSE_LIMIT",
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        incoming.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 1024 * 1024) {
            incoming.destroy();
            reject(
              new AppError(
                "The service response exceeds the read limit.",
                502,
                "CREDENTIAL_RESPONSE_LIMIT",
              ),
            );
          } else chunks.push(chunk);
        });
        incoming.on("error", () =>
          reject(
            new AppError("The service response was interrupted.", 502, "CREDENTIAL_REQUEST_FAILED"),
          ),
        );
        incoming.on("end", () =>
          resolve({ status, contentType, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    outgoing.on("error", () =>
      reject(
        new AppError(
          "Could not reach the credential destination.",
          502,
          "CREDENTIAL_REQUEST_FAILED",
        ),
      ),
    );
    outgoing.end(input.body);
  });
