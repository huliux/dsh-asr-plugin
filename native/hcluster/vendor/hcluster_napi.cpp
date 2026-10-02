#include <napi.h>

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <mutex>
#include <sstream>
#include <string>
#include <sys/stat.h>
#include <sys/types.h>
#include <vector>

#include "fastcluster.h"

class nan_error {};
class fenv_error {};

namespace {

class SimpleLogger {
 public:
  void Initialize(const std::string& base_path, bool log_to_stdout) {
    std::lock_guard<std::mutex> lock(mutex_);
    log_to_stdout_ = log_to_stdout;
    const std::string logs_dir = JoinPath(base_path, "logs");
    if (!EnsureDir(logs_dir)) {
      throw std::runtime_error("Failed to create log directory");
    }
    if (file_.is_open()) {
      file_.close();
    }
    log_file_path_ = JoinPath(logs_dir, "bitbook_hcluster.log");
    file_.open(log_file_path_, std::ios::app);
    if (!file_.is_open()) {
      throw std::runtime_error("Failed to open log file");
    }
  }

  void Info(const std::string& message) {
    Write("INFO", message);
  }

  void Error(const std::string& message) {
    std::cerr << message << std::endl;
    Write("ERROR", message);
  }

  const std::string& LogFilePath() const {
    return log_file_path_;
  }

 private:
  static std::string JoinPath(const std::string& left, const std::string& right) {
    if (left.empty()) {
      return right;
    }
    if (left.back() == '/') {
      return left + right;
    }
    return left + "/" + right;
  }

  static bool EnsureDir(const std::string& path) {
    if (path.empty()) {
      return false;
    }
    std::string current;
    if (path[0] == '/') {
      current = "/";
    }
    std::stringstream ss(path);
    std::string segment;
    while (std::getline(ss, segment, '/')) {
      if (segment.empty()) {
        continue;
      }
      if (current.size() > 1 && current.back() != '/') {
        current.push_back('/');
      }
      current += segment;
      if (mkdir(current.c_str(), 0755) != 0 && errno != EEXIST) {
        return false;
      }
    }
    return true;
  }

  void Write(const char* level, const std::string& message) {
    const std::string line = FormatLine(level, message);
    std::lock_guard<std::mutex> lock(mutex_);
    if (file_.is_open()) {
      file_ << line << std::endl;
      file_.flush();
    }
    // Worker stdout is reserved exclusively for framed protocol messages.
    if (!file_.is_open()) {
      std::cerr << line << std::endl;
    }
  }

  static std::string FormatLine(const char* level, const std::string& message) {
    using namespace std::chrono;
    const auto now = system_clock::now();
    const auto ms = duration_cast<milliseconds>(now.time_since_epoch()) % 1000;
    const std::time_t t = system_clock::to_time_t(now);
    std::tm tm{};
    localtime_r(&t, &tm);
    std::ostringstream oss;
    oss << std::put_time(&tm, "%Y-%m-%d %H:%M:%S") << ','
        << std::setw(3) << std::setfill('0') << ms.count();
    oss << ' ' << level << " [default] " << message;
    return oss.str();
  }

  std::mutex mutex_;
  std::ofstream file_;
  bool log_to_stdout_ = true;
  std::string log_file_path_;
};

SimpleLogger g_logger;

void ThrowTypeError(const Napi::Env& env, const std::string& log_message,
                    const std::string& error_message) {
  g_logger.Error(log_message);
  Napi::TypeError::New(env, error_message).ThrowAsJavaScriptException();
}

void ThrowError(const Napi::Env& env, const std::string& log_message,
                const std::string& error_message) {
  g_logger.Error(log_message);
  Napi::Error::New(env, error_message).ThrowAsJavaScriptException();
}

}  // namespace

class HCluster : public Napi::ObjectWrap<HCluster> {
 public:
  static Napi::Function Init(Napi::Env env) {
    return DefineClass(env, "HCluster", {InstanceMethod("cluster", &HCluster::Cluster)});
  }

  explicit HCluster(const Napi::CallbackInfo& info)
      : Napi::ObjectWrap<HCluster>(info) {
    const Napi::Env env = info.Env();
    try {
      if (info.Length() < 1 || !info[0].IsArray()) {
        ThrowTypeError(env, "HCluster::HCluster: constructor expects an array as the first argument",
                       "constructor expects an array as the first argument");
        return;
      }

      const Napi::Array points = info[0].As<Napi::Array>();
      const uint32_t count = points.Length();
      embeddings_.reserve(count);
      lengths_.reserve(count);

      if (count > 0) {
        if (!ValidatePoint(points.Get(uint32_t{0}), 0, env)) {
          return;
        }
        const auto first = points.Get(uint32_t{0}).As<Napi::Float32Array>();
        dim_ = first.ElementLength();
      }

      for (uint32_t i = 0; i < count; ++i) {
        if (!ValidatePoint(points.Get(i), i, env)) {
          return;
        }
        const auto array = points.Get(i).As<Napi::Float32Array>();
        embeddings_.push_back(Napi::Persistent(array));
        lengths_.push_back(array.ElementLength());
      }

      num_points_ = static_cast<int>(count);
    } catch (const std::exception&) {
      ThrowError(env, "Unexpected exception during HCluster construction",
                 "Unexpected exception during HCluster construction");
    } catch (...) {
      ThrowError(env, "Unknown error during HCluster construction",
                 "Unknown error during HCluster construction");
    }
  }

  Napi::Value Cluster(const Napi::CallbackInfo& info) {
    const Napi::Env env = info.Env();
    try {
      if (info.Length() < 1 || !info[0].IsObject()) {
        ThrowTypeError(env, "HCluster::Cluster: Options object required", "Options object required");
        return env.Null();
      }

      if (num_points_ < 2) {
        ThrowError(env, "HCluster::Cluster: Need at least 2 points for clustering",
                   "Need at least 2 points for clustering");
        return env.Null();
      }

      const Napi::Object options = info[0].As<Napi::Object>();
      bool has_k = false;
      bool has_height = false;
      int k_value = 0;
      double height_value = 0.0;

      if (options.Has("k")) {
        const Napi::Value value = options.Get("k");
        if (!value.IsNumber()) {
          ThrowTypeError(env, "HCluster::Cluster: 'k' must be a number", "'k' must be a number");
          return env.Null();
        }
        k_value = value.As<Napi::Number>().Int32Value();
        if (k_value != 0) {
          has_k = true;
        }
      }

      if (options.Has("height")) {
        const Napi::Value value = options.Get("height");
        if (!value.IsNumber()) {
          ThrowTypeError(env, "HCluster::Cluster: 'height' must be a number",
                         "'height' must be a number");
          return env.Null();
        }
        height_value = value.As<Napi::Number>().DoubleValue();
        if (height_value != 0.0) {
          has_height = true;
        }
      }

      if (has_k && has_height) {
        ThrowError(env, "HCluster::Cluster: Only one of 'k' or 'height' can be provided",
                   "Only one of 'k' or 'height' can be provided");
        return env.Null();
      }
      if (!has_k && !has_height) {
        ThrowError(env, "HCluster::Cluster: Either 'k' or 'height' must be provided",
                   "Either 'k' or 'height' must be provided");
        return env.Null();
      }

      const int n = num_points_;
      const size_t dist_size = static_cast<size_t>(n) * static_cast<size_t>(n - 1) / 2;
      std::vector<double> distmat(dist_size);
      size_t idx = 0;
      for (int i = 0; i < n; ++i) {
        for (int j = i + 1; j < n; ++j) {
          distmat[idx++] = Distance(i, j);
        }
      }

      std::vector<int> merge(static_cast<size_t>(2 * (n - 1)));
      std::vector<double> heights(static_cast<size_t>(n - 1));

      try {
        hclust_fast(n, distmat.data(), HCLUST_METHOD_AVERAGE, merge.data(), heights.data());
      } catch (const nan_error&) {
        ThrowError(env, "HCluster::Cluster: nan_error", "nan_error exception during clustering");
        return env.Null();
      } catch (const fenv_error&) {
        ThrowError(env, "HCluster::Cluster: fenv_error", "fenv_error exception during clustering");
        return env.Null();
      } catch (const std::exception&) {
        ThrowError(env, "Unexpected exception during clustering",
                   "Unexpected exception during clustering");
        return env.Null();
      } catch (...) {
        ThrowError(env, "Unknown error during clustering", "Unknown error during clustering");
        return env.Null();
      }

      std::vector<int> labels(static_cast<size_t>(n));
      if (has_k) {
        cutree_k(n, merge.data(), k_value, labels.data());
      } else {
        cutree_cdist(n, merge.data(), heights.data(), height_value, labels.data());
      }

      Napi::Object result = Napi::Object::New(env);
      Napi::Array merge_arr = Napi::Array::New(env, merge.size());
      for (size_t i = 0; i < merge.size(); ++i) {
        merge_arr.Set(i, Napi::Number::New(env, merge[i]));
      }
      Napi::Array height_arr = Napi::Array::New(env, heights.size());
      for (size_t i = 0; i < heights.size(); ++i) {
        height_arr.Set(i, Napi::Number::New(env, heights[i]));
      }
      Napi::Array labels_arr = Napi::Array::New(env, labels.size());
      for (size_t i = 0; i < labels.size(); ++i) {
        labels_arr.Set(i, Napi::Number::New(env, labels[i]));
      }
      result.Set("merge", merge_arr);
      result.Set("height", height_arr);
      result.Set("labels", labels_arr);
      return result;
    } catch (const std::exception&) {
      ThrowError(env, "Unexpected exception during clustering",
                 "Unexpected exception during clustering");
      return env.Null();
    } catch (...) {
      ThrowError(env, "Unknown error during clustering", "Unknown error during clustering");
      return env.Null();
    }
  }

 private:
  bool ValidatePoint(const Napi::Value& value, uint32_t index, const Napi::Env& env) {
    if (!value.IsTypedArray()) {
      ThrowTypeError(env,
                     "HCluster::HCluster: Expected input[" + std::to_string(index) +
                         "] to be a Float32Array",
                     "Expected input[" + std::to_string(index) + "] to be a Float32Array");
      return false;
    }
    const auto typed = value.As<Napi::TypedArray>();
    if (typed.TypedArrayType() != napi_float32_array) {
      ThrowTypeError(
          env,
          "HCluster::HCluster: Expected input[" + std::to_string(index) +
              "] to be specifically a Float32Array, not another typed array type",
          "Expected input[" + std::to_string(index) +
              "] to be specifically a Float32Array, not another typed array type");
      return false;
    }
    return true;
  }

  double Distance(int i, int j) const {
    if (dim_ == 0) {
      return 0.0;
    }
    if (lengths_[static_cast<size_t>(i)] != dim_ ||
        lengths_[static_cast<size_t>(j)] != dim_) {
      return -1.0;
    }
    const float* a = embeddings_[static_cast<size_t>(i)].Value().Data();
    const float* b = embeddings_[static_cast<size_t>(j)].Value().Data();
    double sum = 0.0;
    for (size_t k = 0; k < dim_; ++k) {
      const double diff = static_cast<double>(a[k]) - static_cast<double>(b[k]);
      sum += diff * diff;
    }
    return std::sqrt(sum);
  }

  std::vector<Napi::Reference<Napi::Float32Array>> embeddings_;
  std::vector<size_t> lengths_;
  size_t dim_ = 0;
  int num_points_ = 0;
};

Napi::Value InitializeModule(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsString() || !info[1].IsString() || !info[2].IsString()) {
    Napi::TypeError::New(
        env, "Expected (filesPath: string, userEmail: string, moduleDir: string, "
             "[logToStdout: boolean])")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  if (info.Length() >= 4 && !info[3].IsBoolean()) {
    Napi::TypeError::New(env, "Expected 4th argument (logToStdout) to be a boolean")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  const std::string files_path = info[0].As<Napi::String>().Utf8Value();
  const bool log_to_stdout = info.Length() >= 4 ? info[3].As<Napi::Boolean>().Value() : false;

  try {
    g_logger.Initialize(files_path, log_to_stdout);
    g_logger.Info("Logging initialized to file: \"" + g_logger.LogFilePath() + "\"");
  } catch (...) {
    g_logger.Error("Failed to initialize logging in hcluster");
    Napi::Error::New(env, "Unknown error in InitializeModule").ThrowAsJavaScriptException();
    return env.Null();
  }

  return env.Undefined();
}

Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
  exports.Set("HCluster", HCluster::Init(env));
  exports.Set("initializeModule", Napi::Function::New(env, InitializeModule));
  return exports;
}

NODE_API_MODULE(hcluster, InitAll)
