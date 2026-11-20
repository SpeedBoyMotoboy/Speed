// Vigia: confere de tempos em tempos se os outros serviços (site, robô do n8n, ponte) respondem.
// Só avisa depois de 2 falhas seguidas, para não alarmar por um soluço de rede. O aviso sai no painel.
export function criarVigia({ alvos, buscar = fetch, agora = () => Date.now() }) {
  const estado = new Map();
  async function conferir() {
    await Promise.all(alvos.map(async ({ nome, url }) => {
      let ok = false;
      try {
        const r = await buscar(url, { signal: AbortSignal.timeout(10_000) });
        ok = r.status < 500;
      } catch { ok = false; }
      const e = estado.get(nome) || { falhas: 0, desde: null };
      estado.set(nome, ok ? { falhas: 0, desde: null } : { falhas: e.falhas + 1, desde: e.desde ?? agora() });
    }));
  }
  function avisos() {
    return alvos.filter(({ nome }) => (estado.get(nome)?.falhas || 0) >= 2).map(({ nome }) => {
      const min = Math.max(1, Math.round((agora() - estado.get(nome).desde) / 60_000));
      return `${nome} fora do ar há ${min} min.`;
    });
  }
  return { conferir, avisos };
}

// "Nome|url" separados por vírgula (variável VIGIA_ALVOS). Vazio = não vigia nada.
export function lerAlvos(texto) {
  return String(texto || '').split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
    const i = p.indexOf('|');
    return { nome: p.slice(0, i).trim(), url: p.slice(i + 1).trim() };
  }).filter((a) => a.nome && /^https?:\/\//.test(a.url));
}
