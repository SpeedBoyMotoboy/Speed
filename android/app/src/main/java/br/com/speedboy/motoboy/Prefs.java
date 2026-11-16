package br.com.speedboy.motoboy;

import android.content.Context;
import android.content.SharedPreferences;

/** Dados guardados no aparelho: servidor, token do turno e fim previsto. */
final class Prefs {
    static final String SERVIDOR = "servidor";
    static final String TOKEN = "token";
    static final String FIM = "fim";
    static final String ROTA_VERSAO = "rota_versao";

    private Prefs() {}

    static SharedPreferences de(Context c) {
        return c.getSharedPreferences("speed", Context.MODE_PRIVATE);
    }

    /** Endereço do servidor: o embutido na compilação tem prioridade sobre o digitado. */
    static String servidor(Context c) {
        if (!BuildConfig.SERVIDOR.isEmpty()) return BuildConfig.SERVIDOR;
        return de(c).getString(SERVIDOR, "");
    }

    static boolean turnoAtivo(Context c) {
        SharedPreferences p = de(c);
        return !p.getString(TOKEN, "").isEmpty()
                && System.currentTimeMillis() < p.getLong(FIM, 0) + RastreioService.FOLGA_MAX_MS;
    }

    static void limparTurno(Context c) {
        de(c).edit().remove(TOKEN).remove(FIM).remove(ROTA_VERSAO).apply();
    }
}
