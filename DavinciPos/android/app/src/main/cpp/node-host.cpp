#include <jni.h>
#include <node.h>
#include <unistd.h>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

extern "C" JNIEXPORT jint JNICALL
Java_com_basmatservice_davincipos_MainActivity_startNodeWithArguments(
    JNIEnv* env, jobject, jobjectArray arguments, jstring workingDirectory) {
  if (arguments == nullptr || workingDirectory == nullptr) return -1;

  const char* cwd = env->GetStringUTFChars(workingDirectory, nullptr);
  if (cwd == nullptr) return -1;
  const int chdirResult = chdir(cwd);
  env->ReleaseStringUTFChars(workingDirectory, cwd);
  if (chdirResult != 0) return -2;

  const jsize count = env->GetArrayLength(arguments);
  if (count <= 0) return -3;

  // nodejs-mobile/libuv expects argv strings to live in one contiguous
  // writable buffer. std::vector<std::string> does NOT guarantee that:
  // each string may own a separate heap allocation. Passing those pointers
  // directly to node::Start can corrupt memory and terminate the process.
  std::vector<jsize> lengths(static_cast<size_t>(count));
  size_t bufferSize = 0;
  for (jsize i = 0; i < count; ++i) {
    auto item = static_cast<jstring>(env->GetObjectArrayElement(arguments, i));
    if (item == nullptr) return -4;
    const jsize length = env->GetStringUTFLength(item);
    env->DeleteLocalRef(item);
    if (env->ExceptionCheck()) return -5;
    lengths[static_cast<size_t>(i)] = length;
    bufferSize += static_cast<size_t>(length) + 1;
  }

  std::vector<char> argumentBuffer(bufferSize, '\0');
  std::vector<char*> argv(static_cast<size_t>(count) + 1, nullptr);
  size_t offset = 0;

  for (jsize i = 0; i < count; ++i) {
    auto item = static_cast<jstring>(env->GetObjectArrayElement(arguments, i));
    if (item == nullptr) return -6;
    const char* value = env->GetStringUTFChars(item, nullptr);
    if (value == nullptr) {
      env->DeleteLocalRef(item);
      return -7;
    }

    argv[static_cast<size_t>(i)] = argumentBuffer.data() + offset;
    const size_t length = static_cast<size_t>(lengths[static_cast<size_t>(i)]);
    std::memcpy(argumentBuffer.data() + offset, value, length);
    argumentBuffer[offset + length] = '\0';
    offset += length + 1;

    env->ReleaseStringUTFChars(item, value);
    env->DeleteLocalRef(item);
    if (env->ExceptionCheck()) return -8;
  }

  // argv[count] is explicitly null-terminated as required by C conventions.
  argv[static_cast<size_t>(count)] = nullptr;
  return node::Start(static_cast<int>(count), argv.data());
}
