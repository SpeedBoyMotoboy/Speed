package br.com.speedboy.motoboy;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.MediaStore;
import android.provider.Settings;
import android.text.InputType;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Locale;

/**
 * Casca do app: mostra a tela do motoboy (servida pelo servidor da Speed) e oferece a ela
 * o que só o Android faz: permissões, rastreio em segundo plano e abrir o mapa.
 */
public class MainActivity extends Activity {
    private static final int PEDIDO_PERMISSAO = 10;
    private static final int PEDIDO_FOTO = 11;
    private ValueCallback<Uri[]> retornoArquivo;
    private Uri fotoUri;
    private static final String PAGINA_ERRO = "speed://";

    private WebView web;
    private final Handler principal = new Handler(Looper.getMainLooper());
    /** Só a página do servidor configurado pode usar a ponte nativa. */
    private volatile boolean paginaConfiavel = false;
    private boolean jaPediuLocal = false;

    @Override
    @SuppressLint("SetJavaScriptEnabled")
    protected void onCreate(Bundle estado) {
        super.onCreate(estado);
        web = new WebView(this);
        setContentView(web);
        // Android 15+ desenha o app atrás da barra de status e da barra de navegação:
        // afasta o conteúdo para nada ficar escondido embaixo delas.
        web.setOnApplyWindowInsetsListener((v, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets i = insets.getInsets(android.view.WindowInsets.Type.systemBars() | android.view.WindowInsets.Type.ime());
                v.setPadding(i.left, i.top, i.right, i.bottom);
            }
            return insets;
        });

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        web.addJavascriptInterface(new Ponte(), "SpeedNativo");
        web.setWebViewClient(new Cliente());
        web.setWebChromeClient(new Arquivos());

        tokenDoLink = lerTokenDoLink(getIntent());
        if (Prefs.servidor(this).isEmpty()) pedirServidor();
        else carregar();
    }

    @Override
    protected void onResume() {
        super.onResume();
        // Turno em andamento e rastreio parado (celular reiniciou, sistema matou): religa.
        if (Prefs.turnoAtivo(this) && !RastreioService.ativo && temLocal()) iniciarServico();
    }

    /** Campo de foto da tela: abre a câmera (Android 10+) ou o seletor de arquivos. */
    private final class Arquivos extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> retorno, FileChooserParams params) {
            if (retornoArquivo != null) retornoArquivo.onReceiveValue(null);
            retornoArquivo = retorno;
            fotoUri = null;
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentValues cv = new ContentValues();
                    cv.put(MediaStore.Images.Media.DISPLAY_NAME, "entrega-" + System.currentTimeMillis() + ".jpg");
                    cv.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
                    fotoUri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, cv);
                }
                if (fotoUri != null) {
                    Intent camera = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
                    camera.putExtra(MediaStore.EXTRA_OUTPUT, fotoUri);
                    camera.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    startActivityForResult(camera, PEDIDO_FOTO);
                } else {
                    startActivityForResult(params.createIntent(), PEDIDO_FOTO);
                }
                return true;
            } catch (Exception e) {
                descartarFoto();
                try {
                    startActivityForResult(params.createIntent(), PEDIDO_FOTO);
                    return true;
                } catch (Exception e2) {
                    retornoArquivo = null;
                    return false;
                }
            }
        }
    }

    private void descartarFoto() {
        if (fotoUri != null) {
            try { getContentResolver().delete(fotoUri, null, null); } catch (Exception e) { /* já não existe */ }
            fotoUri = null;
        }
    }

    @Override
    protected void onActivityResult(int pedido, int resultado, Intent dados) {
        super.onActivityResult(pedido, resultado, dados);
        if (pedido != PEDIDO_FOTO || retornoArquivo == null) return;
        Uri[] escolhido = null;
        if (resultado == RESULT_OK) {
            if (dados != null && dados.getData() != null) { escolhido = new Uri[] { dados.getData() }; descartarFoto(); }
            else if (fotoUri != null) escolhido = new Uri[] { fotoUri };
        } else {
            descartarFoto();
        }
        retornoArquivo.onReceiveValue(escolhido);
        retornoArquivo = null;
        fotoUri = null;
    }

    @Override
    public void onBackPressed() {
        moveTaskToBack(true); // voltar não fecha o app nem o turno
    }

    /** Sessão vinda do botão "Abrir o app" do navegador (speedy://entrar?t=...). */
    private String tokenDoLink;

    private static String lerTokenDoLink(Intent i) {
        Uri u = i == null ? null : i.getData();
        if (u == null || !"speedy".equals(u.getScheme())) return null;
        String t = u.getQueryParameter("t");
        return t != null && t.matches("[A-Za-z0-9._~-]{16,300}") ? t : null;
    }

    @Override
    protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        setIntent(i);
        String t = lerTokenDoLink(i);
        if (t != null && !Prefs.servidor(this).isEmpty()) { tokenDoLink = t; carregar(); }
    }

    private void carregar() {
        String t = tokenDoLink;
        tokenDoLink = null;
        web.loadUrl(Prefs.servidor(this) + "/app/" + (t != null ? "?e=" + System.currentTimeMillis() + "#t=" + t : ""));
    }

    private void pedirServidor() {
        final EditText campo = new EditText(this);
        campo.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        campo.setHint("https://endereco-da-speed");
        campo.setText(Prefs.de(this).getString(Prefs.SERVIDOR, "https://"));
        new AlertDialog.Builder(this)
                .setTitle("Endereço do servidor da Speed")
                .setMessage("Peça o endereço à administração. Precisa começar com https://")
                .setView(campo)
                .setCancelable(false)
                .setPositiveButton("Salvar", (d, w) -> {
                    String url = campo.getText().toString().trim();
                    while (url.endsWith("/")) url = url.substring(0, url.length() - 1);
                    Uri u = Uri.parse(url);
                    if (!"https".equals(u.getScheme()) || u.getHost() == null || u.getHost().isEmpty()) {
                        pedirServidor();
                        return;
                    }
                    Prefs.de(this).edit().putString(Prefs.SERVIDOR, url).apply();
                    carregar();
                })
                .show();
    }

    private boolean doServidor(Uri u) {
        Uri s = Uri.parse(Prefs.servidor(this));
        return u != null && "https".equals(u.getScheme()) && s.getHost() != null
                && s.getHost().equalsIgnoreCase(u.getHost()) && s.getPort() == u.getPort();
    }

    private void mostrarErro() {
        paginaConfiavel = false;
        boolean podeTrocar = BuildConfig.SERVIDOR.isEmpty();
        String html = "<html><head><meta name='viewport' content='width=device-width, initial-scale=1'></head>"
                + "<body style='font-family:sans-serif;background:#111318;color:#fff;padding:32px 24px'>"
                + "<h2>Sem conexão</h2><p>Não consegui falar com o servidor da Speed. Verifique a internet.</p>"
                + "<p><a style='color:#f5a300;font-size:18px' href='" + PAGINA_ERRO + "recarregar'>Tentar de novo</a></p>"
                + (podeTrocar ? "<p><a style='color:#9aa3b0' href='" + PAGINA_ERRO + "servidor'>Trocar endereço do servidor</a></p>" : "")
                + "</body></html>";
        web.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
    }

    private final class Cliente extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest pedido) {
            Uri u = pedido.getUrl();
            String texto = u.toString();
            if (texto.equals(PAGINA_ERRO + "recarregar")) {
                carregar();
                return true;
            }
            if (texto.equals(PAGINA_ERRO + "servidor")) {
                if (BuildConfig.SERVIDOR.isEmpty()) pedirServidor();
                return true;
            }
            if (doServidor(u)) return false;
            abrirFora(new Intent(Intent.ACTION_VIEW, u)); // links externos abrem no navegador
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            paginaConfiavel = url != null && doServidor(Uri.parse(url));
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest pedido, WebResourceError erro) {
            if (pedido.isForMainFrame()) mostrarErro();
        }
    }

    // ------------------------------------------------------------ permissões

    private boolean tem(String permissao) {
        return checkSelfPermission(permissao) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean temLocal() {
        return tem(Manifest.permission.ACCESS_FINE_LOCATION);
    }

    private boolean temNotificacao() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || tem(Manifest.permission.POST_NOTIFICATIONS);
    }

    private boolean gpsLigado() {
        LocationManager lm = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) return lm.isLocationEnabled();
            return lm.isProviderEnabled(LocationManager.GPS_PROVIDER);
        } catch (RuntimeException e) {
            return false;
        }
    }

    private boolean bateriaLivre() {
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        return pm.isIgnoringBatteryOptimizations(getPackageName());
    }

    private void abrirFora(Intent i) {
        try {
            startActivity(i);
        } catch (ActivityNotFoundException | SecurityException e) {
            // nenhum app para abrir: ignora
        }
    }

    /** Pede uma pendência por vez, na ordem que importa para o rastreio funcionar. */
    @SuppressLint("BatteryLife")
    private void pedirPermissoes() {
        if (!temLocal()) {
            boolean negouDeVez = jaPediuLocal && !shouldShowRequestPermissionRationale(Manifest.permission.ACCESS_FINE_LOCATION);
            if (negouDeVez) {
                abrirFora(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName())));
                return;
            }
            jaPediuLocal = true;
            ArrayList<String> lista = new ArrayList<>();
            lista.add(Manifest.permission.ACCESS_FINE_LOCATION);
            lista.add(Manifest.permission.ACCESS_COARSE_LOCATION);
            if (!temNotificacao()) lista.add(Manifest.permission.POST_NOTIFICATIONS);
            requestPermissions(lista.toArray(new String[0]), PEDIDO_PERMISSAO);
        } else if (!gpsLigado()) {
            abrirFora(new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS));
        } else if (!temNotificacao()) {
            requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, PEDIDO_PERMISSAO);
        } else if (!bateriaLivre()) {
            abrirFora(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName())));
        }
    }

    private void iniciarServico() {
        try {
            startForegroundService(new Intent(this, RastreioService.class));
        } catch (RuntimeException e) {
            // Android recusou (app em segundo plano): tenta de novo quando a tela voltar.
        }
    }

    // ------------------------------------------- ponte usada pela tela (JS)

    private final class Ponte {
        @JavascriptInterface
        public String info() {
            if (!paginaConfiavel) return "{}";
            try {
                JSONObject o = new JSONObject();
                o.put("versao", BuildConfig.VERSION_NAME);
                o.put("dispositivo", Settings.Secure.getString(getContentResolver(), Settings.Secure.ANDROID_ID)
                        + " " + Build.MANUFACTURER + " " + Build.MODEL);
                o.put("permLocal", temLocal());
                o.put("permNotif", temNotificacao());
                o.put("gpsLigado", gpsLigado());
                o.put("bateriaLivre", bateriaLivre());
                o.put("servicoAtivo", RastreioService.ativo);
                o.put("camera", true);
                return o.toString();
            } catch (Exception e) {
                return "{}";
            }
        }

        @JavascriptInterface
        public void pedirPermissoes() {
            if (paginaConfiavel) principal.post(MainActivity.this::pedirPermissoes);
        }

        @JavascriptInterface
        public void iniciarTurno(String token, double fimMs) {
            if (!paginaConfiavel || token == null || token.isEmpty()) return;
            Prefs.de(MainActivity.this).edit()
                    .putString(Prefs.TOKEN, token)
                    .putLong(Prefs.FIM, (long) fimMs)
                    .apply();
            principal.post(MainActivity.this::iniciarServico);
        }

        @JavascriptInterface
        public void pararTurno() {
            if (!paginaConfiavel) return;
            Prefs.limparTurno(MainActivity.this);
            principal.post(() -> stopService(new Intent(MainActivity.this, RastreioService.class)));
        }

        @JavascriptInterface
        public void navegar(double lat, double lon) {
            if (!paginaConfiavel) return;
            final String destino = String.format(Locale.US, "%.6f,%.6f", lat, lon);
            principal.post(() -> {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("google.navigation:q=" + destino + "&mode=d")));
                } catch (ActivityNotFoundException | SecurityException e) {
                    abrirFora(new Intent(Intent.ACTION_VIEW, Uri.parse("geo:" + destino + "?q=" + destino)));
                }
            });
        }

        @JavascriptInterface
        public void abrirAjustesLocal() {
            if (paginaConfiavel) principal.post(() -> abrirFora(new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)));
        }
    }
}
