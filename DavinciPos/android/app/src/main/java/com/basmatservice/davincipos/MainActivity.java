package com.basmatservice.davincipos;
import android.app.Activity;
import android.app.AlertDialog;
import android.graphics.Color;
import android.os.Bundle;
import android.view.inputmethod.InputMethodManager;
import android.content.Context;
import android.webkit.*;
import android.widget.*;
import android.text.InputType;

public class MainActivity extends Activity {
 private static final String KEY="server_url";
 private WebView web;
 private String url="";
 @Override public void onCreate(Bundle state){super.onCreate(state);url=getPreferences(0).getString(KEY,"");if(url.isEmpty())setup();else open();}
 private void setup(){
  LinearLayout box=new LinearLayout(this);box.setOrientation(1);box.setPadding(32,48,32,32);box.setBackgroundColor(Color.rgb(245,246,251));
  TextView title=new TextView(this);title.setText("DavinciPos");title.setTextSize(26);title.setTextColor(Color.rgb(35,45,75));box.addView(title);
  TextView hint=new TextView(this);hint.setText("أدخل عنوان خادم المتجر على نفس شبكة Wi-Fi أو LAN. مثال:\\nhttps://192.168.1.10:3000/mobile\\nلا يحتاج الاتصال إلى إنترنت.");hint.setTextSize(15);hint.setTextColor(Color.DKGRAY);hint.setPadding(0,18,0,18);box.addView(hint);
  EditText input=new EditText(this);input.setSingleLine(true);input.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_URI);input.setHint("https://192.168.1.10:3000/mobile");input.setText(url);box.addView(input);
  Button button=new Button(this);button.setText("اتصال بخادم المتجر");box.addView(button);
  button.setOnClickListener(v->{String value=input.getText().toString().trim();if(!value.startsWith("https://")||!value.endsWith("/mobile")){Toast.makeText(this,"استخدم رابط HTTPS وينتهي بـ /mobile",Toast.LENGTH_LONG).show();return;}url=value;getPreferences(0).edit().putString(KEY,url).apply();((InputMethodManager)getSystemService(Context.INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(input.getWindowToken(),0);open();});
  setContentView(box);
 }
 private void open(){
  web=new WebView(this);web.setBackgroundColor(Color.rgb(245,246,251));
  WebSettings s=web.getSettings();s.setJavaScriptEnabled(true);s.setDomStorageEnabled(true);s.setDatabaseEnabled(true);s.setLoadsImagesAutomatically(true);s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
  CookieManager.getInstance().setAcceptCookie(true);CookieManager.getInstance().setAcceptThirdPartyCookies(web,false);
  web.setWebChromeClient(new WebChromeClient());
  web.setWebViewClient(new WebViewClient(){
   @Override public boolean shouldOverrideUrlLoading(WebView v,WebResourceRequest r){return !"https".equals(r.getUrl().getScheme());}
   @Override public void onReceivedError(WebView v,WebResourceRequest r,WebResourceError e){if(r.isForMainFrame())Toast.makeText(MainActivity.this,"تعذر الاتصال بالخادم. تحقق من الشبكة والعنوان.",Toast.LENGTH_LONG).show();}
  });
  setContentView(web);web.loadUrl(url);
 }
 private void changeServer(){
  EditText input=new EditText(this);input.setSingleLine(true);input.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_URI);input.setText(url);
  new AlertDialog.Builder(this).setTitle("عنوان خادم DavinciPos").setView(input).setNegativeButton("إلغاء",null).setPositiveButton("حفظ",(d,w)->{String v=input.getText().toString().trim();if(v.startsWith("https://")&&v.endsWith("/mobile")){url=v;getPreferences(0).edit().putString(KEY,url).apply();web.loadUrl(url);}else Toast.makeText(this,"عنوان HTTPS غير صالح",Toast.LENGTH_LONG).show();}).show();
 }
 @Override public void onBackPressed(){if(web!=null&&web.canGoBack())web.goBack();else if(web!=null)changeServer();else super.onBackPressed();}
}
