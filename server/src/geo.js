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

// ---------------------------------------------------------------- Google Maps (opcional)
// Com a chave do Google em Configurações, a busca acha rua difícil e loja pelo nome ("KS loja Jardim Camburi").
// Tenta o Geocoding; se não achar ou só achar parecido, tenta o Places (busca por texto). Sem chave, ou se o
// Google recusar, vale o Nominatim de sempre.
const cacheGoogle = new Map();
const ES = { sul: -21.4, oeste: -41.9, norte: -17.8, leste: -39.6 };
async function googleJson(url, buscar) {
  const r = await buscar(url, { signal: AbortSignal.timeout(7000) });
  if (!r.ok) return null;
  const j = await r.json();
  if (j.status && !['OK', 'ZERO_RESULTS'].includes(j.status)) console.error('[google]', j.status, String(j.error_message || '').slice(0, 160));
  return j;
}
export async function geocodificarGoogle(chave, consulta, limite = 5, buscar = fetch) {
  const id = `${limite}|${consulta.toLowerCase()}`;
  if (cacheGoogle.has(id)) return cacheGoogle.get(id);
  const ler = (lista, nome) => (lista || [])
    .map((x) => ({ nome: String(nome(x)), lat: Number(x.geometry?.location?.lat), lon: Number(x.geometry?.location?.lng) }))
    .filter((x) => coordValida(x.lat, x.lon)).slice(0, limite);
  let achados = [];
  const g = await googleJson('https://maps.googleapis.com/maps/api/geocode/json?' + new URLSearchParams({
    address: consulta, region: 'br', language: 'pt-BR', components: 'country:BR',
    bounds: `${ES.sul},${ES.oeste}|${ES.norte},${ES.leste}`, key: chave,
  }), buscar);
  const exatos = (g?.results || []).filter((x) => !x.partial_match && !(x.types || []).some((t) => ['locality', 'administrative_area_level_1', 'administrative_area_level_2', 'country'].includes(t)));
  achados = ler(exatos, (x) => x.formatted_address);
  if (!achados.length) {
    const p = await googleJson('https://maps.googleapis.com/maps/api/place/textsearch/json?' + new URLSearchParams({
      query: consulta, region: 'br', language: 'pt-BR', location: '-20.30,-40.30', radius: '90000', key: chave,
    }), buscar);
    achados = ler(p?.results, (x) => (x.name && !String(x.formatted_address || '').startsWith(x.name) ? `${x.name} · ${x.formatted_address}` : x.formatted_address));
  }
  if (!achados.length) achados = ler(g?.results, (x) => x.formatted_address);
  if (achados.length) {
    if (cacheGoogle.size > 1000) cacheGoogle.clear();
    cacheGoogle.set(id, achados);
  }
  return achados;
}
// Busca de endereço do sistema: Google primeiro (se houver chave), Nominatim como reserva.
export function criarGeocodificador(lerChave, buscar = fetch) {
  return async (texto, opcoes = {}) => {
    const chave = String(lerChave() || '');
    if (chave) {
      const base = String(texto || '').trim().slice(0, 200);
      const cidade = String(opcoes.cidadeBase || '').trim();
      const primeira = cidade.split(',')[0].trim().toLowerCase();
      const consulta = cidade && !base.toLowerCase().includes(primeira) && !/ - es\b|esp[ií]rito santo/i.test(base) ? `${base}, ${cidade}` : base;
      if (base.length >= 4) {
        try {
          const r = await geocodificarGoogle(chave, consulta, opcoes.limite ?? 5, buscar);
          if (r.length) return r;
        } catch (e) { console.error('[google]', e.message); }
      }
    }
    return geocodificar(texto, opcoes);
  };
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
