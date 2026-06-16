/**
 * Geocoder — env-free, pure fetch.
 *
 * All functions take the API key as a parameter; they never import env.
 * This keeps them fully testable without any process.env setup and keeps
 * the router import tree side-effect free.
 *
 * Never log the key. Never expose it in error messages.
 */

interface GoogleGeocodeResponse {
  status: string;
  results: Array<{
    geometry: {
      location: {
        lat: number;
        lng: number;
      };
    };
  }>;
}

/**
 * Geocode a structured address to lat/lng using Google Geocoding REST API.
 *
 * @param input   Structured address fields.
 * @param apiKey  Google Geocoding API key (never logged).
 * @returns `{ lat, lng }` for the first result, or `null` on ZERO_RESULTS or error.
 */
export async function geocodeAddress(
  input: {
    address: string;
    city: string;
    state: string;
    zip: string;
  },
  apiKey: string,
): Promise<{ lat: number; lng: number } | null> {
  const fullAddress = `${input.address}, ${input.city}, ${input.state} ${input.zip}`;
  const encoded = encodeURIComponent(fullAddress);
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encoded}`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "X-Goog-Api-Key": apiKey },
    });
  } catch {
    // Network error
    return null;
  }

  if (!response.ok) {
    return null;
  }

  let data: GoogleGeocodeResponse;
  try {
    data = (await response.json()) as GoogleGeocodeResponse;
  } catch {
    return null;
  }

  if (data.status === "ZERO_RESULTS" || !data.results || data.results.length === 0) {
    return null;
  }

  // Any non-OK status (REQUEST_DENIED, INVALID_REQUEST, etc.) → null
  if (data.status !== "OK") {
    return null;
  }

  const location = data.results[0]?.geometry?.location;
  if (!location) {
    return null;
  }

  return { lat: location.lat, lng: location.lng };
}
