import express from "express";
import bodyParser from "body-parser";
import crypto from "crypto";

const app = express();
// PayU puede enviar x-www-form-urlencoded al webhook:
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Respeta proto/host cuando estamos detrás de Cloudflare Tunnel
app.set("trust proxy", true);

// === SANDBOX (credenciales públicas de prueba) ===
const PAYU_ACTION = "https://sandbox.checkout.payulatam.com/ppp-web-gateway-payu";
const MERCHANT_ID = "508029";
const ACCOUNT_ID  = "512321";
const API_KEY     = "4Vj8eK4rloUd272L48hsrarnUA"; // para firma
// =================================================

// Tu URL pública del Quick Tunnel (prod-like)
const PUBLIC_BASE_DEFAULT = "https://determines-depends-disabled-costume.trycloudflare.com";

// Si defines BASE_URL en el entorno, la usamos; si no, usamos la del Quick Tunnel
const BASE_URL = process.env.BASE_URL || PUBLIC_BASE_DEFAULT;

// Firma WebCheckout: MD5(ApiKey~merchantId~referenceCode~amount~currency)
function makeSignature(reference: string, amount: string, currency: string) {
  const raw = [API_KEY, MERCHANT_ID, reference, amount, currency].join("~");
  return crypto.createHash("md5").update(raw).digest("hex");
}

// Almacenamiento en memoria de sesiones de checkout (demo)
type Fields = Record<string, string>;
const sessions = new Map<string, { fields: Fields; expiresAt: number }>();
const TTL_MS = 10 * 60 * 1000; // 10 minutos

// Limpieza básica de sesiones expiradas
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions.entries()) {
    if (v.expiresAt <= now) sessions.delete(k);
  }
}, 60_000);

// Log “bonito” de payloads PayU
function logPayuPayload(tag: string, data: any) {
  const pick = (k: string) => data?.[k] ?? data?.query?.[k] ?? data?.body?.[k];
  const overview = {
    referenceCode: pick("referenceCode"),
    transactionId: pick("transactionId"),
    transactionState: pick("transactionState") || pick("lapTransactionState"),
    lapResponseCode: pick("lapResponseCode"),
    message: pick("message") || pick("responseMessage"),
    signature: pick("signature"),
  };
  console.log(`[${tag}] overview:`, overview);
  console.log(`[${tag}] full payload:`, data);
}

/**
 * POST /api/payu/checkout
 * body: { amount, currency="COP", reference, description?, buyerEmail? }
 * Devuelve: { payUrl } -> al abrirlo en el navegador, auto-postea a PayU.
 */
app.post("/api/payu/checkout", (req, res) => {
  const { amount, currency = "COP", reference, description, buyerEmail } = req.body;

  if (!amount || !reference) {
    return res.status(400).json({ ok: false, error: "amount y reference son requeridos" });
  }

  const amountStr = Number(amount).toFixed(2);
  const signature = makeSignature(reference, amountStr, currency);

  const fields: Fields = {
    merchantId: MERCHANT_ID,
    accountId : ACCOUNT_ID,
    description: description ?? `Compra ${reference}`,
    referenceCode: String(reference),
    amount: amountStr,
    currency: String(currency),
    buyerEmail: buyerEmail ?? "buyer@test.com",
    signature,
    responseUrl: `${BASE_URL}/payu/response`,
    confirmationUrl: `${BASE_URL}/api/payu/confirm`,
    test: "1",
  };

  // Genera un token de sesión y guarda los campos
  const token = crypto.randomUUID();
  sessions.set(token, { fields, expiresAt: Date.now() + TTL_MS });

  // Devuelve un link único que auto-publicará el form a PayU
  const payUrl = `${BASE_URL}/payu/redirect/${token}`;

  console.log("[checkout] request body:", req.body);
  console.log("[checkout] fields to PayU:", fields);
  console.log("[checkout] payUrl:", payUrl);

  return res.json({
    ok: true,
    payUrl,        // <--- ESTE ES EL LINK QUE ABRES PARA PAGAR
    // opcional para depurar:
    action: PAYU_ACTION,
    fields
  });
});

/**
 * GET /payu/redirect/:token
 * Página efímera que auto-postea a PayU con los campos firmados.
 */
app.get("/payu/redirect/:token", (req, res) => {
  const { token } = req.params;
  const sess = sessions.get(token);
  if (!sess) {
    return res.status(410).send("Link vencido o inválido.");
  }
  const { fields } = sess;

  console.log("[redirect] token:", token);
  console.log("[redirect] fields:", fields);

  // HTML auto-submit
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Redirigiendo a PayU…</title></head>
  <body onload="document.forms[0].submit()" style="font-family: sans-serif">
    <p>Redirigiendo a PayU…</p>
    <form method="post" action="${PAYU_ACTION}">
      ${Object.entries(fields)
        .map(([k, v]) => `<input type="hidden" name="${k}" value="${String(v).replace(/"/g, "&quot;")}" />`)
        .join("\n")}
      <noscript><button type="submit">Pagar en PayU</button></noscript>
    </form>
  </body>
</html>`);
});

/**
 * /payu/response — visible para el comprador (redirige el navegador)
 */
app.all("/payu/response", (req, res) => {
  const data = { query: req.query, body: (req as any).body };
  logPayuPayload("responseUrl", data);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<h1>Resultado WebCheckout</h1>
  <pre>${JSON.stringify(data, null, 2)}</pre>
  <p><b>Nota:</b> esta es la página para el usuario. La confirmación canónica llega a <code>/api/payu/confirm</code>.</p>`);
});

/**
 * /api/payu/confirm — webhook (server-to-server)
 */
app.post("/api/payu/confirm", (req, res) => {
  // PayU suele enviar form-urlencoded; ya lo aceptamos con bodyParser.
  logPayuPayload("confirmationUrl (webhook)", req.body);
  // TODO: Actualiza tu orden en DB según estado recibido (idempotente).
  res.sendStatus(200);
});

// Health
app.get("/api", (_req, res) => res.json({ conexion: "ok", baseUrl: BASE_URL }));

app.listen(3000, () => {
  console.log("PayU WebCheckout sandbox server on http://localhost:3000");
  console.log("BASE_URL:", BASE_URL);
});
