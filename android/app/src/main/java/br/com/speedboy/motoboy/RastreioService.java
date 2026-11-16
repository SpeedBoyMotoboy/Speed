package br.com.speedboy.motoboy;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.PowerManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.Locale;

/**
 * Rastreio durante o turno. Serviço em primeiro plano (notificação fixa): continua
 * com a tela apagada e com o app fechado, e para sozinho quando o servidor encerra o turno.
 * Sem internet, guarda os pontos e envia quando a conexão voltar.
 */
public class RastreioService extends Service implements LocationListener {
    /** Depois do fim previsto o servidor ainda pode prorrogar; passado isso, para de qualquer jeito. */
    static final long FOLGA_MAX_MS = 3 * 60 * 60 * 1000L;
    static volatile boolean ativo = false;

    private static final String CANAL_TURNO = "turno";
    private static final String CANAL_AVISO = "aviso";
    private static final int ID_TURNO = 1;
    private static final int ID_NOVA_ROTA = 2;
    private static final long INTERVALO_ENVIO_MS = 15_000;
    private static final long INTERVALO_PONTO_MS = 5_000;
    private static final int FILA_MAX = 5000;
    private static final int LOTE_MAX = 500;

    private LocationManager localizacao;
    private HandlerThread fio;
    private Handler handler;
    private PowerManager.WakeLock trava;
    private final ArrayList<JSONObject> fila = new ArrayList<>(); // só usada no fio de rastreio
    private long ultimoPonto = 0;
    private long ultimoGps = 0;
    private String servidor = "";
    private String token = "";
    private long fim = 0;

    private final Runnable ciclo = new Runnable() {
        @Override
        public void run() {
            enviar();
            if (ativo && handler != null) handler.postDelayed(this, INTERVALO_ENVIO_MS);
        }
    };

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        SharedPreferences p = Prefs.de(this);
        servidor = Prefs.servidor(this);
        token = p.getString(Prefs.TOKEN, "");
        fim = p.getLong(Prefs.FIM, 0);
        criarCanais(this);

        Notification n = notificacaoTurno();
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(ID_TURNO, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            } else {
                startForeground(ID_TURNO, n);
            }
        } catch (RuntimeException e) {
            // Sem permissão de localização ou iniciado em segundo plano: não dá para rastrear.
            stopSelf();
            return START_NOT_STICKY;
        }

        if (token.isEmpty() || servidor.isEmpty() || !Prefs.turnoAtivo(this)) {
            parar();
            return START_NOT_STICKY;
        }
        if (!ativo) iniciar();
        return START_STICKY;
    }

    private void iniciar() {
        ativo = true;
        localizacao = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        fio = new HandlerThread("speed-rastreio");
        fio.start();
        handler = new Handler(fio.getLooper());

        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        trava = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "speed:rastreio");
        trava.setReferenceCounted(false);
        trava.acquire(Math.max(60_000L, fim + FOLGA_MAX_MS - System.currentTimeMillis()));

        pedirAtualizacoes(LocationManager.GPS_PROVIDER, INTERVALO_PONTO_MS);
        pedirAtualizacoes(LocationManager.NETWORK_PROVIDER, INTERVALO_ENVIO_MS);
        handler.post(ciclo);
    }

    private void pedirAtualizacoes(String provedor, long intervalo) {
        try {
            if (localizacao.getAllProviders().contains(provedor)) {
                localizacao.requestLocationUpdates(provedor, intervalo, 0f, this, fio.getLooper());
            }
        } catch (SecurityException | IllegalArgumentException e) {
            // Permissão retirada no meio do turno: o servidor acusa "sem sinal".
        }
    }

    // ------------------------------------------------------------ localização

    @Override
    public void onLocationChanged(Location l) {
        long agora = System.currentTimeMillis();
        boolean gps = LocationManager.GPS_PROVIDER.equals(l.getProvider());
        if (gps) ultimoGps = agora;
        else if (agora - ultimoGps < 30_000) return; // com GPS bom, ignora a posição aproximada da rede
        if (agora - ultimoPonto < INTERVALO_PONTO_MS) return;
        ultimoPonto = agora;
        try {
            JSONObject p = new JSONObject();
            p.put("lat", l.getLatitude());
            p.put("lon", l.getLongitude());
            p.put("ts", agora);
            if (l.hasAccuracy()) p.put("precisao", l.getAccuracy());
            if (l.hasSpeed()) p.put("velocidade", l.getSpeed());
            if (localizacaoFalsa(l)) p.put("falso", true);
            fila.add(p);
            if (fila.size() > FILA_MAX) fila.remove(0);
        } catch (Exception e) {
            // ponto inválido: descarta
        }
    }

    @SuppressWarnings("deprecation")
    private static boolean localizacaoFalsa(Location l) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) return l.isMock();
        return l.isFromMockProvider();
    }

    @Override
    public void onProviderEnabled(String provider) {}

    @Override
    public void onProviderDisabled(String provider) {}

    @Override
    @SuppressWarnings("deprecation")
    public void onStatusChanged(String provider, int status, Bundle extras) {}

    private boolean gpsLigado() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) return localizacao.isLocationEnabled();
            return localizacao.isProviderEnabled(LocationManager.GPS_PROVIDER);
        } catch (RuntimeException e) {
            return false;
        }
    }

    // ------------------------------------------------------------------ envio

    /** Roda no fio de rastreio. Manda os pontos acumulados (ou só um "estou vivo"). */
    private void enviar() {
        if (System.currentTimeMillis() > fim + FOLGA_MAX_MS) {
            encerrar();
            return;
        }
        int n = Math.min(fila.size(), LOTE_MAX);
        HttpURLConnection con = null;
        try {
            JSONArray pontos = new JSONArray();
            for (int i = 0; i < n; i++) pontos.put(fila.get(i));
            JSONObject corpo = new JSONObject();
            corpo.put("pontos", pontos);
            corpo.put("gps_ligado", gpsLigado());
            BatteryManager bm = (BatteryManager) getSystemService(Context.BATTERY_SERVICE);
            int bateria = bm == null ? -1 : bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
            if (bateria >= 0 && bateria <= 100) corpo.put("bateria", bateria);

            con = (HttpURLConnection) new URL(servidor + "/api/motoboy/posicoes").openConnection();
            con.setConnectTimeout(10_000);
            con.setReadTimeout(10_000);
            con.setRequestMethod("POST");
            con.setDoOutput(true);
            con.setRequestProperty("Content-Type", "application/json");
            con.setRequestProperty("Authorization", "Bearer " + token);
            byte[] dados = corpo.toString().getBytes(StandardCharsets.UTF_8);
            con.setFixedLengthStreamingMode(dados.length);
            try (OutputStream out = con.getOutputStream()) {
                out.write(dados);
            }

            int status = con.getResponseCode();
            if (status == 200) {
                fila.subList(0, n).clear();
                tratarResposta(ler(con.getInputStream()));
            } else if (status == 401) {
                encerrar();
            } else if (status >= 400 && status < 500) {
                fila.subList(0, n).clear(); // o servidor recusou este lote: não adianta repetir
            }
        } catch (Exception e) {
            // Sem internet: os pontos ficam na fila e vão no próximo ciclo.
        } finally {
            if (con != null) con.disconnect();
        }
    }

    private static String ler(InputStream in) throws Exception {
        try (InputStream entrada = in; ByteArrayOutputStream saida = new ByteArrayOutputStream()) {
            byte[] buf = new byte[4096];
            int lidos;
            while ((lidos = entrada.read(buf)) > 0 && saida.size() < 65536) saida.write(buf, 0, lidos);
            return saida.toString("UTF-8");
        }
    }

    private void tratarResposta(String texto) {
        try {
            JSONObject r = new JSONObject(texto);
            SharedPreferences p = Prefs.de(this);
            long novoFim = r.optLong("fim_previsto", fim);
            if (novoFim != fim) {
                fim = novoFim;
                p.edit().putLong(Prefs.FIM, fim).apply();
            }
            int versao = r.optInt("rota_versao", 0);
            int vista = p.getInt(Prefs.ROTA_VERSAO, -1);
            if (versao > vista) {
                p.edit().putInt(Prefs.ROTA_VERSAO, versao).apply();
                if (vista >= 0 && r.optInt("pendentes", 0) > 0) {
                    avisar(this, ID_NOVA_ROTA, "Nova demanda na sua rota", "Toque para ver a próxima parada.");
                }
            }
        } catch (Exception e) {
            // resposta inesperada: ignora
        }
    }

    private void encerrar() {
        Prefs.limparTurno(this);
        avisar(this, ID_NOVA_ROTA, "Turno encerrado", "A localização não está mais sendo enviada.");
        parar();
    }

    private void parar() {
        ativo = false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        ativo = false;
        if (localizacao != null) {
            try {
                localizacao.removeUpdates(this);
            } catch (RuntimeException e) {
                // já removido
            }
        }
        if (handler != null) handler.removeCallbacksAndMessages(null);
        if (fio != null) fio.quitSafely();
        if (trava != null && trava.isHeld()) trava.release();
        super.onDestroy();
    }

    // ----------------------------------------------------------- notificações

    static void criarCanais(Context c) {
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        NotificationChannel turno = new NotificationChannel(CANAL_TURNO, "Turno ativo", NotificationManager.IMPORTANCE_LOW);
        turno.setDescription("Fica visível enquanto a localização é enviada à Speed.");
        NotificationChannel aviso = new NotificationChannel(CANAL_AVISO, "Novas demandas", NotificationManager.IMPORTANCE_HIGH);
        aviso.setDescription("Avisa quando entra demanda ou o turno termina.");
        aviso.enableVibration(true);
        nm.createNotificationChannel(turno);
        nm.createNotificationChannel(aviso);
    }

    private static PendingIntent abrirApp(Context c) {
        Intent i = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(c, 0, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private Notification notificacaoTurno() {
        String ate = new SimpleDateFormat("HH:mm", Locale.getDefault()).format(new Date(fim));
        return new Notification.Builder(this, CANAL_TURNO)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("Speed: turno ativo até " + ate)
                .setContentText("Sua localização está sendo enviada à Speed.")
                .setContentIntent(abrirApp(this))
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .build();
    }

    static void avisar(Context c, int id, String titulo, String texto) {
        try {
            criarCanais(c);
            Notification n = new Notification.Builder(c, CANAL_AVISO)
                    .setSmallIcon(R.drawable.ic_stat)
                    .setContentTitle(titulo)
                    .setContentText(texto)
                    .setContentIntent(abrirApp(c))
                    .setAutoCancel(true)
                    .build();
            ((NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE)).notify(id, n);
        } catch (RuntimeException e) {
            // notificações bloqueadas pelo usuário
        }
    }
}
