#include <jni.h>
#include <node.h>
#include <unistd.h>
#include <string>
#include <vector>

extern "C" JNIEXPORT jint JNICALL
Java_com_basmatservice_davincipos_MainActivity_startNodeWithArguments(
    JNIEnv* env, jobject, jobjectArray arguments, jstring workingDirectory) {
  const char* cwd = env->GetStringUTFChars(workingDirectory, nullptr);
  if (cwd == nullptr) return -1;
  const int chdirResult = chdir(cwd);
  env->ReleaseStringUTFChars(workingDirectory, cwd);
  if (chdirResult != 0) return -2;

  const jsize count = env->GetArrayLength(arguments);
  std::vector<std::string> values;
  std::vector<char*> argv;
  values.reserve(static_cast<size_t>(count));
  argv.reserve(static_cast<size_t>(count));
  for (jsize i = 0; i < count; ++i) {
    auto item = static_cast<jstring>(env->GetObjectArrayElement(arguments, i));
    const char* value = env->GetStringUTFChars(item, nullptr);
    values.emplace_back(value ? value : "");
    if (value) env->ReleaseStringUTFChars(item, value);
    env->DeleteLocalRef(item);
  }
  for (auto& value : values) argv.push_back(value.data());
  return node::Start(static_cast<int>(argv.size()), argv.data());
}
