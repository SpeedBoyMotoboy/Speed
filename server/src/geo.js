// Distâncias e busca de endereço (OpenStreetMap / Nominatim, gratuito).

const RAIO_TERRA_M = 6371000;
// Linha reta subestima o trajeto na rua; este fator aproxima o desvio urbano.
export const FATOR_RUA = 1.35;

const rad = (g) => (g * Math.PI) / 180;

export function distM(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * RAIO_TERRA_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function distRuaKm(a, b) {
  return (distM(a, b) * FATOR_RUA) / 1000;
}

export function coordValida(lat, lon) {
  return (
    typeof lat === 'number' && typeof lon === 'number' &&
    Number.isFinite(lat) && Number.isFinite(lon) &&
    lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 &&
    !(lat === 0 && lon === 0)
  );
}

// O Nominatim público aceita no máximo 1 consulta por segundo: fila + cache.
let fila = Promise.resolve();
let ultimaConsulta = 0;
const cache = new Map();

export function geocodificar(texto, { cidadeBase = '', limite = 5 } = {}) {
  const base = String(texto || '').trim().slice(0, 200);
  if (base.length < 4) return Promise.resolve([]);
  const cidade = String(cidadeBase || '').trim();
  const primeiraParte = cidade.split(',')[0].trim().toLowerCase();
  const consulta =
    cidade && !base.toLowerCase().includes(primeiraParte) ? `${base}, ${cidade}` : base;
  const chave = `${limite}|${consulta.toLowerCase()}`;
  if (cache.has(chave)) return Promise.resolve(cache.get(chave));

  const tarefa = fila.then(async () => {
    const espera = ultimaConsulta + 1100 - Date.now();
    if (espera > 0) await new Promise((r) => setTimeout(r, espera));
    ultimaConsulta = Date.now();
    const url =
      'https://nominatim.openstreetmap.org/search?' +
      new URLSearchParams({
        q: consulta,
        format: 'jsonv2',
        limit: String(limite),
        countrycodes: 'br',
        'accept-language': 'pt-BR',
      });
    const r = await fetch(url, {
      headers: { 'User-Agent': 'speed-despacho/1.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`geocodificação falhou (${r.status})`);
    const lista = (await r.json())
      .map((x) => ({ nome: String(x.display_name), lat: Number(x.lat), lon: Number(x.lon) }))
      .filter((x) => coordValida(x.lat, x.lon));
    if (cache.size > 500) cache.clear();
    cache.set(chave, lista);
    return lista;
  });
  fila = tarefa.catch(() => {});
  return tarefa;
}

// Distância pelas ruas (OpenRouteService, chave gratuita). Devolve km ou null se não der.
const cacheRota = new Map();
export async function kmPelasRuas(chave, a, b, buscar = fetch) {
  const id = [a.lat, a.lon, b.lat, b.lon].map((n) => Number(n).toFixed(4)).join(',');
  if (cacheRota.has(id)) return cacheRota.get(id);
  try {
    const url = 'https://api.openrouteservice.org/v2/directions/driving-car?' +
      new URLSearchParams({ start: `${a.lon},${a.lat}`, end: `${b.lon},${b.lat}` });
    const r = await buscar(url, { headers: { Authorization: chave }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const metros = (await r.json())?.features?.[0]?.properties?.summary?.distance;
    if (!Number.isFinite(metros) || metros <= 0) return null;
    if (cacheRota.size > 2000) cacheRota.clear();
    cacheRota.set(id, metros / 1000);
    return metros / 1000;
  } catch {
    return null;
  }
}
