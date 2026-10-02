{
  "targets": [
    {
      "target_name": "fbank",
      "sources": [
        "src/fbank_napi.cpp",
        "vendor/kaldi-native-fbank/csrc/feature-fbank.cc",
        "vendor/kaldi-native-fbank/csrc/feature-functions.cc",
        "vendor/kaldi-native-fbank/csrc/feature-window.cc",
        "vendor/kaldi-native-fbank/csrc/fftsg.cc",
        "vendor/kaldi-native-fbank/csrc/kaldi-math.cc",
        "vendor/kaldi-native-fbank/csrc/log.cc",
        "vendor/kaldi-native-fbank/csrc/mel-computations.cc",
        "vendor/kaldi-native-fbank/csrc/rfft.cc"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "vendor"
      ],
      "cflags_cc": [
        "-std=c++17",
        "-fexceptions",
        "-fvisibility=hidden"
      ],
      "defines": [
        "KNF_ENABLE_CHECK=1",
        "NAPI_CPP_EXCEPTIONS",
        "NAPI_VERSION=8"
      ],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "GCC_GENERATE_DEBUGGING_SYMBOLS": "NO",
        "GCC_INLINES_ARE_PRIVATE_EXTERN": "YES",
        "GCC_SYMBOLS_PRIVATE_EXTERN": "YES",
        "MACOSX_DEPLOYMENT_TARGET": "11.0"
      }
    }
  ]
}
