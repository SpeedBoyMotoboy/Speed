// Relatórios: por motoboy, por entrega, por cliente e o fechamento do período.
const MIN = 60_000;

export function criarRelatorios({ q, cfgBruta, agora }) {
  function relatorio(de, ate) {
    const c = cfgBruta();
    const porDiaria = Number(c.diaria_valor) + Number(c.almoco_valor);
    const linhas = q(`
      SELECT m.id AS motoboy_id, m.nome, m.diaria_valor AS diaria_propria,
        COALESCE(SUM(t.tipo = 'diaria'), 0) AS diarias,
        (SELECT COALESCE(SUM(d.repasse), 0) FROM demandas d JOIN turnos t5 ON t5.id = d.turno_id
          WHERE t5.motoboy_id = m.id AND t5.tipo = 'avulso' AND d.status = 'entregue' AND t5.inicio >= ? AND t5.inicio < ?) AS repasses,
        COALESCE(SUM(COALESCE(t.fim_real, ?) - t.inicio), 0) AS ms_turno,
        COALESCE(SUM(t.km), 0) AS km,
        (SELECT COUNT(*) FROM demandas d JOIN turnos t2 ON t2.id = d.turno_id
          WHERE t2.motoboy_id = m.id AND d.status = 'entregue' AND t2.inicio >= ? AND t2.inicio < ?) AS entregas,
        (SELECT COALESCE(SUM(COALESCE(a.fim, ?) - a.inicio), 0) FROM alertas a JOIN turnos t3 ON t3.id = a.turno_id
          WHERE t3.motoboy_id = m.id AND a.tipo = 'parado' AND t3.inicio >= ? AND t3.inicio < ?) AS ms_parado,
        (SELECT COUNT(*) FROM alertas a JOIN turnos t4 ON t4.id = a.turno_id
          WHERE t4.motoboy_id = m.id AND t4.inicio >= ? AND t4.inicio < ?) AS alertas
      FROM motoboys m JOIN turnos t ON t.motoboy_id = m.id
      WHERE t.inicio >= ? AND t.inicio < ?
      GROUP BY m.id ORDER BY m.nome`).all(de, ate, agora(), de, ate, agora(), de, ate, de, ate, de, ate);
    return linhas.map((l) => ({
      motoboy_id: l.motoboy_id,
      nome: l.nome,
      diarias: l.diarias,
      horas: Math.round((l.ms_turno / 3_600_000) * 10) / 10,
      km: Math.round(l.km * 10) / 10,
      entregas: l.entregas,
      min_parado: Math.round(l.ms_parado / MIN),
      alertas: l.alertas,
      repasses: Math.round(l.repasses * 100) / 100,
      valor: Math.round((l.diarias * (l.diaria_propria != null ? l.diaria_propria + Number(c.almoco_valor) : porDiaria) + l.repasses) * 100) / 100,
    }));
  }
  // Cada entrega concluída: quanto o cliente pagou, quanto vai para o motoboy avulso e o que fica.
  function relatorioEntregas(de, ate) {
    return q(`SELECT d.id, d.entregue_em, d.cliente, d.servico, d.km, d.valor, d.pagamento, m.nome AS motoboy, t.tipo,
        CASE WHEN t.tipo = 'avulso' THEN COALESCE(d.repasse, 0) ELSE 0 END AS repasse
      FROM demandas d LEFT JOIN turnos t ON t.id = d.turno_id LEFT JOIN motoboys m ON m.id = d.motoboy_id
      WHERE d.status = 'entregue' AND d.entregue_em >= ? AND d.entregue_em < ?
      ORDER BY d.entregue_em DESC LIMIT 2000`).all(de, ate)
      .map((l) => ({ ...l, margem: l.valor == null ? null : Math.round((l.valor - l.repasse) * 100) / 100 }));
  }

  // Fechamento do período: o que entrou, o que sai para motoboy e o que sobra (sem gasolina nem anúncio).
  function fechamento(de, ate) {
    const dono = Number(cfgBruta().dono_motoboy_id || 0);
    const ent = relatorioEntregas(de, ate);
    const faturado = ent.reduce((s, x) => s + (x.valor || 0), 0);
    const repasses = ent.reduce((s, x) => s + x.repasse, 0);
    const diarias = relatorio(de, ate).filter((l) => l.motoboy_id !== dono).reduce((s, l) => s + (l.valor - l.repasses), 0);
    const canc = q("SELECT COUNT(*) AS n, COALESCE(SUM(valor), 0) AS v FROM demandas WHERE status = 'cancelada' AND cancelada_em >= ? AND cancelada_em < ?").get(de, ate);
    const r2 = (v) => Math.round(v * 100) / 100;
    return {
      entregas: ent.length, faturado: r2(faturado), repasses: r2(repasses), diarias: r2(diarias), lucro: r2(faturado - repasses - diarias),
      cancelados: canc.n, cancelado_valor: r2(canc.v),
      em_aberto: q("SELECT COUNT(*) AS n FROM demandas WHERE status IN ('aguardando','atribuida','coletada') AND criada_em < ?").get(ate).n,
      sem_foto: q("SELECT COUNT(*) AS n FROM demandas WHERE status = 'entregue' AND foto_em IS NULL AND entregue_em >= ? AND entregue_em < ?").get(de, ate).n,
    };
  }
  // Entregas concluídas no período, somadas por cliente (para cobrar).
  function relatorioClientes(de, ate) {
    return q(`SELECT cliente, cliente_telefone AS telefone, COUNT(*) AS entregas,
        COALESCE(SUM(km), 0) AS km, COALESCE(SUM(valor), 0) AS valor
      FROM demandas WHERE status = 'entregue' AND entregue_em >= ? AND entregue_em < ?
      GROUP BY cliente, cliente_telefone ORDER BY valor DESC, entregas DESC`).all(de, ate)
      .map((l) => ({ ...l, km: Math.round(l.km * 10) / 10, valor: Math.round(l.valor * 100) / 100 }));
  }

  return { relatorio, relatorioEntregas, fechamento, relatorioClientes };
}
