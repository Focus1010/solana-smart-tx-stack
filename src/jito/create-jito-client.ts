import { config } from "../config";
import { Logger } from "../utils/logger";
import { JitoBundleClient } from "./jito-bundle-client";
import { JitoGrpcClientImpl } from "./jito-grpc-client";
import { JitoJsonRpcClientImpl } from "./jito-jsonrpc-client";

/**
 * Creates the active Jito transport.
 * Uses gRPC when JITO_USE_GRPC=true; otherwise JSON-RPC (works everywhere).
 */
export function createJitoClient(logger: Logger): JitoBundleClient {
  const useGrpc = process.env.JITO_USE_GRPC === "true";

  if (useGrpc) {
    try {
      // Normalize endpoint for gRPC client: remove any http(s) or grpc scheme and trailing slash
      let endpoint = config.jito.blockEngineUrl ?? "";
      endpoint = endpoint.replace(/^https?:\/\//, "").replace(/^grpc:\/\//, "").replace(/\/$/, "");
      // If no explicit port provided, append :443 for TLS
      if (!/:\d+$/.test(endpoint)) endpoint = endpoint + ":443";
      logger.info("[jito] Using gRPC searcher transport", { endpoint }).catch(() => {});
      return new JitoGrpcClientImpl(endpoint, logger, config.jito.rateLimitMs);
    } catch (err) {
    }
  }

  return new JitoJsonRpcClientImpl(config.jito.rpcUrl);
}
