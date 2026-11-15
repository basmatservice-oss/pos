cmake_minimum_required(VERSION 3.22.1)
project(davincipos_node LANGUAGES CXX)

add_library(node SHARED IMPORTED)
set_target_properties(node PROPERTIES
  IMPORTED_LOCATION "${CMAKE_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libnode.so"
)
include_directories("${CMAKE_SOURCE_DIR}/include/node")

add_library(davincipos-native SHARED node-host.cpp)
find_library(log-lib log)
find_library(android-lib android)
target_compile_features(davincipos-native PRIVATE cxx_std_20)
target_link_libraries(davincipos-native node ${log-lib} ${android-lib})
