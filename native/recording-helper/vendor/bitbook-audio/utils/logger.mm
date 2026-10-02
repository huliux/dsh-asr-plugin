#import "logger.h"
#import <iostream>
#import <iomanip>
#import <sstream>
#import <fstream>
#import <ctime>
#import <cstdarg>
#import <cstring>
#import <chrono>

namespace bitbook::utils {

// ==================== 静态成员变量初始化 ====================

LogLevel Logger::currentLevel_ = LogLevel::Info;
std::mutex Logger::mutex_;
static std::ofstream g_logFile;
static bool g_logFileEnabled = false;
static bool g_compatFormatEnabled = false;
static std::string g_logFilePath;

// ==================== 日志级别管理 ====================

void Logger::setLogLevel(LogLevel level) {
    std::lock_guard<std::mutex> lock(mutex_);
    currentLevel_ = level;
}

LogLevel Logger::getLogLevel() {
    std::lock_guard<std::mutex> lock(mutex_);
    return currentLevel_;
}

void Logger::setCompatFormat(bool enabled) {
    std::lock_guard<std::mutex> lock(mutex_);
    g_compatFormatEnabled = enabled;
}

bool Logger::setLogFile(const std::string& path) {
    std::lock_guard<std::mutex> lock(mutex_);

    if (g_logFile.is_open()) {
        g_logFile.close();
    }

    g_logFileEnabled = false;
    g_logFilePath = path;
    if (path.empty()) {
        return false;
    }

    g_logFile.open(path, std::ios::out | std::ios::app);
    if (!g_logFile.is_open()) {
        return false;
    }

    g_logFileEnabled = true;
    return true;
}

// ==================== 便捷日志方法 ====================

void Logger::debug(const std::string& message) {
    log(LogLevel::Debug, message);
}

void Logger::info(const std::string& message) {
    log(LogLevel::Info, message);
}

void Logger::warning(const std::string& message) {
    log(LogLevel::Warning, message);
}

void Logger::error(const std::string& message) {
    log(LogLevel::Error, message);
}

// ==================== 格式化日志方法 ====================

void Logger::debugf(const char* format, ...) {
    char buffer[4096];
    va_list args;
    va_start(args, format);
    vsnprintf(buffer, sizeof(buffer), format, args);
    va_end(args);
    log(LogLevel::Debug, std::string(buffer));
}

void Logger::infof(const char* format, ...) {
    char buffer[4096];
    va_list args;
    va_start(args, format);
    vsnprintf(buffer, sizeof(buffer), format, args);
    va_end(args);
    log(LogLevel::Info, std::string(buffer));
}

void Logger::warningf(const char* format, ...) {
    char buffer[4096];
    va_list args;
    va_start(args, format);
    vsnprintf(buffer, sizeof(buffer), format, args);
    va_end(args);
    log(LogLevel::Warning, std::string(buffer));
}

void Logger::errorf(const char* format, ...) {
    char buffer[4096];
    va_list args;
    va_start(args, format);
    vsnprintf(buffer, sizeof(buffer), format, args);
    va_end(args);
    log(LogLevel::Error, std::string(buffer));
}

// ==================== 私有方法 ====================

void Logger::log(LogLevel level, const std::string& message) {
    std::lock_guard<std::mutex> lock(mutex_);

    // 检查日志级别过滤
    if (static_cast<int>(level) < static_cast<int>(currentLevel_)) {
        return;
    }

    // 获取日志级别前缀
    const char* levelPrefix = getLevelPrefix(level);

    // 根据日志级别选择输出流
    std::ostream& out = (level >= LogLevel::Error) ? std::cerr : std::cout;

    if (g_compatFormatEnabled) {
        auto now = std::chrono::system_clock::now();
        auto msTotal = std::chrono::duration_cast<std::chrono::milliseconds>(
            now.time_since_epoch());
        int ms = static_cast<int>(msTotal.count() % 1000);
        std::time_t nowTime = std::chrono::system_clock::to_time_t(now);
        std::tm* tm = std::localtime(&nowTime);

        std::ostringstream oss;
        oss << std::put_time(tm, "%Y-%m-%d %H:%M:%S") << ','
            << std::setw(3) << std::setfill('0') << ms
            << ' ' << levelPrefix << " [default] " << message;

        const std::string line = oss.str();
        out << line << std::endl;
        if (g_logFileEnabled) {
            g_logFile << line << std::endl;
            g_logFile.flush();
        }
        return;
    }

    // 获取时间戳
    std::string timestamp = getCurrentTimestamp();

    // 输出日志
    const std::string line = timestamp + " [" + levelPrefix + "] " + message;
    out << line << std::endl;
    if (g_logFileEnabled) {
        g_logFile << line << std::endl;
        g_logFile.flush();
    }
}

const char* Logger::getLevelPrefix(LogLevel level) {
    switch (level) {
        case LogLevel::Debug:
            return "DEBUG";
        case LogLevel::Info:
            return "INFO";
        case LogLevel::Warning:
            return "WARNING";
        case LogLevel::Error:
            return "ERROR";
        default:
            return "UNKNOWN";
    }
}

std::string Logger::getCurrentTimestamp() {
    // 获取当前时间
    auto now = std::time(nullptr);
    auto tm = std::localtime(&now);

    // 格式化时间字符串
    std::ostringstream oss;
    oss << "[" << std::put_time(tm, "%Y-%m-%d %H:%M:%S") << "]";
    return oss.str();
}

} // namespace bitbook::utils
