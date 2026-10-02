#include <napi.h>

#include <algorithm>
#include <cstdint>
#include <limits>
#include <stdexcept>
#include <vector>

#include "kaldi-native-fbank/csrc/feature-fbank.h"

namespace {

constexpr int32_t kSampleRate = 16000;
constexpr int32_t kMelBins = 80;

knf::FbankOptions CreateOptions() {
  knf::FbankOptions options;
  options.frame_opts.samp_freq = static_cast<float>(kSampleRate);
  options.frame_opts.frame_shift_ms = 10.0f;
  options.frame_opts.frame_length_ms = 25.0f;
  options.frame_opts.dither = 0.0f;
  options.frame_opts.preemph_coeff = 0.97f;
  options.frame_opts.remove_dc_offset = true;
  options.frame_opts.window_type = "hamming";
  options.frame_opts.round_to_power_of_two = true;
  options.frame_opts.snip_edges = true;
  options.mel_opts.num_bins = kMelBins;
  options.mel_opts.low_freq = 20.0f;
  options.mel_opts.high_freq = 0.0f;
  options.use_energy = false;
  options.raw_energy = true;
  options.htk_compat = false;
  options.use_log_fbank = true;
  options.use_power = true;
  return options;
}

Napi::Value ExtractFbank(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  try {
    if (info.Length() != 1 || !info[0].IsTypedArray()) {
      throw Napi::TypeError::New(env, "fbank expects one Float32Array");
    }
    const Napi::TypedArray typed = info[0].As<Napi::TypedArray>();
    if (typed.TypedArrayType() != napi_float32_array) {
      throw Napi::TypeError::New(env, "fbank expects one Float32Array");
    }
    const Napi::Float32Array samples = info[0].As<Napi::Float32Array>();
    if (samples.ElementLength() > static_cast<size_t>(std::numeric_limits<int32_t>::max())) {
      throw Napi::RangeError::New(env, "fbank input is too large");
    }

    const knf::FbankOptions options = CreateOptions();
    const int32_t frames = knf::NumFrames(
        static_cast<int64_t>(samples.ElementLength()), options.frame_opts, true);
    Napi::Float32Array data = Napi::Float32Array::New(
        env, static_cast<size_t>(frames) * static_cast<size_t>(kMelBins));
    const std::vector<float> waveform(
        samples.Data(), samples.Data() + samples.ElementLength());
    knf::FeatureWindowFunction window_function(options.frame_opts);
    knf::FbankComputer computer(options);
    std::vector<float> window;
    for (int32_t frame = 0; frame < frames; ++frame) {
      std::fill(window.begin(), window.end(), 0.0f);
      float raw_log_energy = 0.0f;
      knf::ExtractWindow(
          0, waveform, frame, options.frame_opts, window_function, &window,
          computer.NeedRawLogEnergy() ? &raw_log_energy : nullptr);
      computer.Compute(
          raw_log_energy, 1.0f, &window, data.Data() + frame * kMelBins);
    }
    Napi::Array dims = Napi::Array::New(env, 2);
    dims.Set(uint32_t{0}, Napi::Number::New(env, frames));
    dims.Set(uint32_t{1}, Napi::Number::New(env, kMelBins));
    Napi::Object result = Napi::Object::New(env);
    result.Set("data", data);
    result.Set("dims", dims);
    return result;
  } catch (const Napi::Error& error) {
    error.ThrowAsJavaScriptException();
  } catch (const std::exception& error) {
    Napi::Error::New(env, error.what()).ThrowAsJavaScriptException();
  } catch (...) {
    Napi::Error::New(env, "fbank extraction failed").ThrowAsJavaScriptException();
  }
  return env.Undefined();
}

Napi::Object Initialize(Napi::Env env, Napi::Object exports) {
  exports.Set("fbank", Napi::Function::New(env, ExtractFbank));
  return exports;
}

}  // namespace

NODE_API_MODULE(fbank, Initialize)
