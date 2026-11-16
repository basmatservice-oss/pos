package com.basmatservice.davincipos

import android.content.Context
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * WebView transport for the Kotlin-native local API facade.
 * Only explicitly supported routes are intercepted; all other requests remain
 * on the existing server until their Kotlin workflows are complete.
 */
class DavinciWebViewBridge(
    context: Context,
    private val webView: WebView
) {
    private val appContext = context.applicationContext
    private val auth = DavinciAuthRepository(appContext)
    private val api = DavinciLocalApiFacade(appContext)
    private val executor = Executors.newFixedThreadPool(2)

    @JavascriptInterface
    fun supports(method: String, rawPath: String): Boolean {
        val path = rawPath.substringBefore('?').trimEnd('/')
        return when {
            method == "GET" && path in setOf(
                "/api/services", "/api/settings", "/api/tax-profiles", "/api/settlements/customers", "/api/settlements/suppliers", "/api/customers", "/api/suppliers", "/api/products", "/api/categories", "/api/units"
            ) -> true
            method == "POST" && path in setOf(
                "/api/services", "/api/tax-profiles", "/api/customers", "/api/suppliers",
                "/api/products", "/api/categories", "/api/units"
            ) -> true
            method == "PUT" && path in setOf("/api/settings") -> true
            method == "GET" && path.startsWith("/api/barcode/") -> true
            (method == "GET" || method == "POST") && path.matches(Regex("^/api/products/[^/]+/units$")) -> true
            method == "PATCH" && path.matches(Regex("^/api/services/[^/]+$")) -> true
            (method == "GET" || method == "PUT") &&
                path.matches(Regex("^/api/services/[^/]+/components$")) -> true
            method == "GET" && path.matches(Regex("^/api/(customers|suppliers)/[^/]+/statement$")) -> true
            method == "POST" && path.matches(Regex("^/api/(sales|purchases)/[^/]+/payments$")) -> true
            else -> false
        }
    }

    @JavascriptInterface
    fun request(
        requestId: String,
        method: String,
        path: String,
        body: String?,
        bearerToken: String?,
        idempotencyKey: String?
    ) {
        executor.execute {
            val result = try {
                val user = auth.authenticate(bearerToken)
                    ?: return@execute respond(requestId, 401, JSONObject().put("error", "Authentication required."))
                val permission = requiredPermission(method, path)
                if (permission !in user.permissions) {
                    DavinciLocalApiResult(403, JSONObject().put("error", "Permission denied."))
                } else {
                    api.dispatch(
                        method = method,
                        rawPath = path,
                        body = body?.takeIf { it.isNotBlank() }?.let { JSONObject(it) } ?: JSONObject(),
                        actorUserId = user.id,
                        idempotencyKey = idempotencyKey
                    )
                }
            } catch (error: Exception) {
                DavinciLocalApiResult(
                    400,
                    JSONObject().put("error", error.message ?: "Native request failed.")
                )
            }
            respond(requestId, result.statusCode, result.body)
        }
    }

    private fun requiredPermission(method: String, rawPath: String): String {
        val path = rawPath.substringBefore('?').trimEnd('/')
        return when {
            path == "/api/settings" && method == "GET" -> "settings.read"
            path == "/api/settings" && method == "PUT" -> "settings.update"
            path == "/api/tax-profiles" && method == "GET" -> "settings.read"
            path == "/api/tax-profiles" && method == "POST" -> "settings.update"
            path == "/api/services" && method == "GET" -> "products.read"
            path == "/api/services" && method == "POST" -> "products.write"
            path.matches(Regex("^/api/services/[^/]+$")) && method == "PATCH" -> "products.write"
            path.matches(Regex("^/api/services/[^/]+/components$")) && method == "GET" -> "products.read"
            path.matches(Regex("^/api/services/[^/]+/components$")) && method == "PUT" -> "products.write"
            path == "/api/customers" && method == "GET" -> "customers.read"
            path == "/api/customers" && method == "POST" -> "customers.write"
            path == "/api/suppliers" && method == "GET" -> "suppliers.read"
            path == "/api/suppliers" && method == "POST" -> "suppliers.write"
            path == "/api/settlements/customers" -> "customers.balance.read"
            path == "/api/settlements/suppliers" -> "suppliers.balance.read"
            path.matches(Regex("^/api/customers/[^/]+/statement$")) -> "customers.balance.read"
            path.matches(Regex("^/api/suppliers/[^/]+/statement$")) -> "suppliers.balance.read"
            path.matches(Regex("^/api/sales/[^/]+/payments$")) -> "sales.collect"
            path.matches(Regex("^/api/purchases/[^/]+/payments$")) -> "purchases.pay"
            else -> throw IllegalArgumentException("Unsupported native route.")
        }
    }

    private fun respond(requestId: String, status: Int, body: JSONObject) {
        val id = JSONObject.quote(requestId)
        val json = JSONObject.quote(body.toString())
        webView.post {
            webView.evaluateJavascript(
                "window.__davinciNativeResolve && window.__davinciNativeResolve($id,$status,JSON.parse($json));",
                null
            )
        }
    }

    companion object {
        @JvmField
        val BOOTSTRAP_SCRIPT = """
            (function(){
              if(window.__davinciNativeBridgeInstalled)return;
              window.__davinciNativeBridgeInstalled=true;
              const originalFetch=window.fetch.bind(window);
              const pending=new Map();
              let sequence=0;
              window.__davinciNativeResolve=function(id,status,body){
                const resolve=pending.get(String(id));
                if(!resolve)return;
                pending.delete(String(id));
                resolve(new Response(JSON.stringify(body),{
                  status:status,
                  headers:{'Content-Type':'application/json; charset=utf-8'}
                }));
              };
              window.fetch=function(input,init){
                const rawUrl=typeof input==='string'?input:input.url;
                const method=String((init&&init.method)||(input&&input.method)||'GET').toUpperCase();
                let url;
                try{url=new URL(rawUrl,location.href);}catch{return originalFetch(input,init);}
                if(url.origin!==location.origin||!url.pathname.startsWith('/api/')||
                   !window.DavinciNative.supports(method,url.pathname)){
                  return originalFetch(input,init);
                }
                const headers=new Headers((init&&init.headers)||(input instanceof Request?input.headers:undefined));
                const authorization=headers.get('Authorization')||'';
                const token=authorization.replace(/^Bearer\\s+/i,'');
                const idempotencyKey=headers.get('Idempotency-Key')||'';
                const body=init&&typeof init.body==='string'?init.body:'';
                return new Promise(resolve=>{
                  const id=String(++sequence);
                  pending.set(id,resolve);
                  window.DavinciNative.request(id,method,url.pathname+url.search,body,token,idempotencyKey);
                });
              };
            })();
        """.trimIndent()
    }
}
