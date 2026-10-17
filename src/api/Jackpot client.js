
const WORKER_BASE_URL =
  'https://jackpot-api.kasgoatpro.workers.dev';

async function fetchFromWorker(query) {
  const normalizedQuery = query.startsWith('?')
    ? query
    : `?${query}`;

  const url = `${WORKER_BASE_URL}/${normalizedQuery}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(
      `Mr. Jackpot API request failed (${response.status})`
    );
  }

  return response.json();
}

export const jackpotApi = {
  fetchFromWorker,
};
