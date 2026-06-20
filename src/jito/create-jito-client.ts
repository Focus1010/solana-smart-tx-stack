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
      const endpoint = config.jito.blockEngineUrl;
      logger.info("[jito] Using gRPC searcher transport", { endpoint }).catch(() => {});
      return new JitoGrpcClientImpl(endpoint, logger, config.jito.rateLimitMs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("[jito] gRPC client init failed; falling back to JSON-RPC", {
        message: msg,
      }).catch(() => {});
    }
  }

  return new JitoJsonRpcClientImpl(config.jito.rpcUrl);
}
