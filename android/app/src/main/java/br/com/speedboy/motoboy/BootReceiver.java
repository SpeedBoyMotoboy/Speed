package br.com.speedboy.motoboy;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Celular reiniciou no meio do turno: o Android não deixa religar o rastreio sozinho
 * em segundo plano, então avisamos o motoboy para abrir o app.
 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;
        if (!Prefs.turnoAtivo(context)) return;
        RastreioService.avisar(context, 3, "Turno em andamento",
                "O celular reiniciou. Toque aqui para reativar a localização.");
    }
}
