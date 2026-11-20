// Conversas do WhatsApp importadas (arquivo exportado): importar, listar, ler e excluir.
import { lerConversa, textoDoZip, nomeDaConversa } from './whatsapp.js';

export function criarConversas({ q, tx, agora, auditar, Erro }) {
  // Importa a conversa exportada. Reimportar a mesma conversa só acrescenta o que é novo.
  function importarWhatsapp({ arquivo, conteudo }, ator) {
    const buf = Buffer.from(String(conteudo || ''), 'base64');
    if (!buf.length) throw new Erro(422, 'arquivo_vazio', 'Arquivo vazio.');
    let texto;
    try {
      texto = buf.readUInt32LE(0) === 0x04034b50 ? textoDoZip(buf) : buf.toString('utf8');
    } catch (e) {
      throw new Erro(422, 'arquivo_invalido', `Não consegui abrir o arquivo: ${e.message}.`);
    }
    const lista = lerConversa(texto);
    if (!lista.length) {
      throw new Erro(422, 'sem_mensagens', 'Não achei mensagens. Use "Exportar conversa" do WhatsApp e envie o .txt ou o .zip.');
    }
    const nome = nomeDaConversa(arquivo);
    return tx(() => {
      const t = agora();
      q(`INSERT INTO conversas (nome, criada_em, atualizada_em) VALUES (?,?,?)
         ON CONFLICT(nome) DO UPDATE SET atualizada_em = excluded.atualizada_em`).run(nome, t, t);
      const conversa = q('SELECT id FROM conversas WHERE nome = ?').get(nome);
      const inserir = q('INSERT OR IGNORE INTO mensagens (conversa_id, ts, autor, texto) VALUES (?,?,?,?)');
      let novas = 0;
      for (const m of lista) novas += inserir.run(conversa.id, m.ts, m.autor ?? '', m.texto).changes;
      auditar(ator, 'whatsapp_importado', `${nome}: ${novas} nova(s)`);
      return { conversa_id: conversa.id, nome, lidas: lista.length, novas };
    });
  }
  function listarConversas() {
    return q(`SELECT c.id, c.nome, c.atualizada_em, c.telefone, c.humano, c.pendente, c.pausa_ate, COUNT(m.id) AS total,
        MIN(m.ts) AS primeira, MAX(m.ts) AS ultima, COUNT(m.demanda_id) AS demandas
      FROM conversas c LEFT JOIN mensagens m ON m.conversa_id = c.id
      GROUP BY c.id ORDER BY c.pendente DESC, c.atualizada_em DESC LIMIT 300`).all();
  }
  function mensagensDaConversa(conversaId, busca = '') {
    const termo = `%${String(busca).trim().slice(0, 100).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return q(`SELECT id, ts, autor, texto, demanda_id, direcao FROM mensagens
      WHERE conversa_id = ? AND (texto LIKE ? ESCAPE '\\' OR autor LIKE ? ESCAPE '\\')
      ORDER BY ts DESC, id DESC LIMIT 500`).all(conversaId, termo, termo);
  }
  function excluirConversa(conversaId, ator) {
    const c = q('SELECT nome FROM conversas WHERE id = ?').get(conversaId);
    if (!c) throw new Erro(404, 'nao_encontrado', 'Conversa não encontrada.');
    tx(() => {
      q('DELETE FROM mensagens WHERE conversa_id = ?').run(conversaId);
      q('DELETE FROM conversas WHERE id = ?').run(conversaId);
      auditar(ator, 'whatsapp_excluido', c.nome);
    });
  }

  return { importarWhatsapp, listarConversas, mensagensDaConversa, excluirConversa };
}
