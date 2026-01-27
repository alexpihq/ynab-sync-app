import { logger } from './logger.js';

/**
 * QuotaGuard Static IP Proxy utility
 * Provides fallback logic: try direct first, then via proxy on 403
 */

// Environment variable for QuotaGuard proxy URL
const QUOTAGUARD_URL = process.env.QUOTAGUARDSTATIC_URL || '';

interface ProxyFetchOptions extends RequestInit {
  /** Timeout in milliseconds */
  timeout?: number;
  /** Services that should use proxy on 403 error */
  useProxyOn403?: boolean;
}

/**
 * Parse QuotaGuard URL to extract proxy settings
 * Format: http://user:password@proxy.quotaguardstatic.com:9293
 */
function parseProxyUrl(proxyUrl: string): { host: string; port: number; auth?: string } | null {
  try {
    const url = new URL(proxyUrl);
    const auth = url.username && url.password
      ? `${url.username}:${url.password}`
      : undefined;
    return {
      host: url.hostname,
      port: parseInt(url.port) || 9293,
      auth
    };
  } catch {
    return null;
  }
}

/**
 * Make a fetch request through QuotaGuard proxy
 * Uses CONNECT tunnel for HTTPS requests
 */
async function fetchViaProxy(
  url: string,
  options: RequestInit,
  timeout: number
): Promise<Response> {
  if (!QUOTAGUARD_URL) {
    throw new Error('QUOTAGUARDSTATIC_URL not configured');
  }

  const proxyConfig = parseProxyUrl(QUOTAGUARD_URL);
  if (!proxyConfig) {
    throw new Error('Invalid QUOTAGUARDSTATIC_URL format');
  }

  // Dynamic import for https-proxy-agent
  const { HttpsProxyAgent } = await import('https-proxy-agent');

  const agent = new HttpsProxyAgent(QUOTAGUARD_URL);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      // @ts-ignore - Node.js fetch supports agent
      agent,
      signal: controller.signal
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Make a direct fetch request (without proxy)
 */
async function fetchDirect(
  url: string,
  options: RequestInit,
  timeout: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Fetch with automatic fallback to QuotaGuard proxy on 403 error
 *
 * @param url - URL to fetch
 * @param options - Fetch options with additional proxy settings
 * @returns Response from the API
 *
 * @example
 * ```ts
 * const response = await proxyFetch('https://api.tbank.ru/...', {
 *   method: 'GET',
 *   headers: { 'Authorization': 'Bearer ...' },
 *   timeout: 30000,
 *   useProxyOn403: true
 * });
 * ```
 */
export async function proxyFetch(
  url: string,
  options: ProxyFetchOptions = {}
): Promise<Response> {
  const { timeout = 30000, useProxyOn403 = false, ...fetchOptions } = options;

  // First, try direct request
  try {
    logger.debug(`Direct fetch: ${url}`);
    const response = await fetchDirect(url, fetchOptions, timeout);

    // If 403 and proxy fallback is enabled, try via proxy
    if (response.status === 403 && useProxyOn403 && QUOTAGUARD_URL) {
      logger.warn(`Got 403 on direct request, trying via QuotaGuard proxy...`);

      // Clone the response body to log the error
      const errorBody = await response.text();
      logger.debug(`403 error body: ${errorBody.substring(0, 200)}`);

      // Try via proxy
      const proxyResponse = await fetchViaProxy(url, fetchOptions, timeout);

      if (proxyResponse.ok) {
        logger.info(`✅ Request succeeded via QuotaGuard proxy`);
      } else {
        logger.warn(`Proxy request returned ${proxyResponse.status}`);
      }

      return proxyResponse;
    }

    return response;
  } catch (error: any) {
    // If direct request failed completely and proxy is available, try proxy
    if (useProxyOn403 && QUOTAGUARD_URL && error.name !== 'AbortError') {
      logger.warn(`Direct request failed (${error.message}), trying via QuotaGuard proxy...`);

      try {
        const proxyResponse = await fetchViaProxy(url, fetchOptions, timeout);
        logger.info(`✅ Request succeeded via QuotaGuard proxy after direct failure`);
        return proxyResponse;
      } catch (proxyError: any) {
        logger.error(`Proxy request also failed: ${proxyError.message}`);
        throw proxyError;
      }
    }

    throw error;
  }
}

/**
 * Check if QuotaGuard proxy is configured
 */
export function isProxyConfigured(): boolean {
  return !!QUOTAGUARD_URL;
}

/**
 * Get the current outbound IP (useful for debugging)
 * Uses QuotaGuard's IP check endpoint
 */
export async function getOutboundIP(useProxy: boolean = false): Promise<string> {
  const url = 'https://ip.quotaguard.com';

  try {
    let response: Response;

    if (useProxy && QUOTAGUARD_URL) {
      response = await fetchViaProxy(url, {}, 10000);
    } else {
      response = await fetchDirect(url, {}, 10000);
    }

    if (response.ok) {
      return (await response.text()).trim();
    }

    throw new Error(`Failed to get IP: ${response.status}`);
  } catch (error: any) {
    logger.error(`Failed to get outbound IP: ${error.message}`);
    throw error;
  }
}
