// Regras de escolha do motoboy e ordenação da rota. Funções puras (sem banco).
import { distRuaKm } from './geo.js';

export const REQUISITOS = ['qualquer', 'moto', 'bau', 'bag'];

// O motoboy tem o equipamento/veículo que a demanda exige?
export function atende(motoboy, demanda, { bikeMaxKm }) {
  if (demanda.requisito === 'bau' && !motoboy.tem_bau) return false;
  if (demanda.requisito === 'bag' && !motoboy.tem_bag) return false;
  if (demanda.requisito === 'moto' && motoboy.veiculo !== 'moto') return false;
  if (motoboy.veiculo === 'bike') {
    const trecho = distRuaKm(
      { lat: demanda.coleta_lat, lon: demanda.coleta_lon },
      { lat: demanda.entrega_lat, lon: demanda.entrega_lon },
    );
    if (trecho > bikeMaxKm) return false;
  }
  return true;
}

// Km da rota, partindo da posição atual (ou da primeira parada, se não há posição).
export function comprimentoRota(origem, paradas) {
  let total = 0;
  let anterior = origem;
  for (const p of paradas) {
    if (anterior) total += distRuaKm(anterior, p);
    anterior = p;
  }
  return total;
}

// Encaixa coleta e entrega na rota existente onde somar menos km,
// sempre com a coleta antes da entrega e sem mexer na ordem do que já estava.
export function melhorInsercao(origem, paradas, coleta, entrega) {
  const base = comprimentoRota(origem, paradas);
  let melhor = null;
  for (let i = 0; i <= paradas.length; i++) {
    for (let j = i; j <= paradas.length; j++) {
      const rota = [
        ...paradas.slice(0, i),
        coleta,
        ...paradas.slice(i, j),
        entrega,
        ...paradas.slice(j),
      ];
      const custo = comprimentoRota(origem, rota) - base;
      if (!melhor || custo < melhor.custo - 1e-9) melhor = { custo, rota };
    }
  }
  return melhor;
}

// candidatos: [{ turno, motoboy, rota, emAlmoco }]. Devolve o de menor custo ou null.
export function escolherMotoboy(demanda, candidatos, cfg) {
  const coleta = { lat: demanda.coleta_lat, lon: demanda.coleta_lon };
  const entrega = { lat: demanda.entrega_lat, lon: demanda.entrega_lon };
  let melhor = null;
  for (const c of candidatos) {
    if (!atende(c.motoboy, demanda, cfg)) continue;
    const temPosicao = c.turno.ult_lat != null;
    const origem = temPosicao ? { lat: c.turno.ult_lat, lon: c.turno.ult_lon } : null;
    const ins = melhorInsercao(origem, c.rota, coleta, entrega);
    // Penalidades: fila já cheia, almoço em andamento, posição ainda desconhecida.
    const custo =
      ins.custo + 0.5 * c.rota.length + (c.emAlmoco ? 3 : 0) + (temPosicao ? 0 : 5);
    if (!melhor || custo < melhor.custo) melhor = { ...c, custo, kmExtra: ins.custo };
  }
  return melhor;
}
