'use strict';

/**
 * Proveedor OCR: Oracle Cloud Infrastructure · Document Understanding (TEXT_EXTRACTION).
 * Las credenciales se leen del fichero de config estándar de OCI (~/.oci/config o OCI_CONFIG_FILE),
 * nunca del repositorio.
 */
function createOciProvider({ compartmentId, configFile, profile = 'DEFAULT', region } = {}) {
  if (!compartmentId) throw new Error('OCI_COMPARTMENT_ID es obligatorio');

  // Carga perezosa: los tests y el modo demo no necesitan el SDK
  const common = require('oci-common');
  const { AIServiceDocumentClient } = require('oci-aidocument');

  const provider = new common.ConfigFileAuthenticationDetailsProvider(configFile, profile);
  const client = new AIServiceDocumentClient({ authenticationDetailsProvider: provider });
  if (region) client.regionId = region;

  return {
    name: 'oci',
    async extractText(base64Pdf) {
      const response = await client.analyzeDocument({
        analyzeDocumentDetails: {
          compartmentId,
          features: [{ featureType: 'TEXT_EXTRACTION' }],
          document: { source: 'INLINE', data: base64Pdf },
        },
        // Los reintentos los gestiona el servicio (circuit breaker), no el SDK
        retryConfiguration: common.NoRetryConfigurationDetails,
      });
      const lines = [];
      for (const page of response?.analyzeDocumentResult?.pages || []) {
        for (const line of page.lines || []) if (line.text) lines.push(line.text);
      }
      return lines.join('\n');
    },
  };
}

module.exports = { createOciProvider };
