{
  "targets": [
    {
      "target_name": "hcluster",
      "sources": [
        "vendor/fastcluster.cpp",
        "vendor/hcluster_napi.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "cflags_cc": [
        "-std=c++17",
        "-fexceptions"
      ],
      "defines": [
        "NAPI_CPP_EXCEPTIONS",
        "NAPI_VERSION=8"
      ],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "GCC_GENERATE_DEBUGGING_SYMBOLS": "NO"
      }
    }
  ]
}
