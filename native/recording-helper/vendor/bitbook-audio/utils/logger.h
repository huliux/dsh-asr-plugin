#ifndef LOGGER_H
#define LOGGER_H

#include <string>
#include <mutex>

namespace bitbook::utils {

/**
 * @brief 日志级别枚举
 */
enum class LogLevel {
    Debug = 0,    // 调试信息 (详细的执行流程、变量值等)
    Info = 1,     // 一般信息 (正常的业务流程、状态变化)
    Warning = 2,  // 警告信息 (潜在问题，但不影响正常运行)
    Error = 3     // 错误信息 (严重问题，可能影响功能)
};

/**
 * @brief 统一日志系统
 *
 * Logger 类提供了统一的日志输出功能，支持多级别日志和格式化输出。
 * 这是一个静态工具类，所有方法都是静态方法，无需实例化。
 *
 * 核心功能:
 * - 多级别日志 (Debug, Info, Warning, Error)
 * - 统一的日志格式 ([时间戳] [级别] 消息)
 * - 可配置的日志级别过滤
 * - 线程安全的日志输出
 * - 支持格式化字符串 (printf 风格)
 *
 * 日志格式:
 * [YYYY-MM-DD HH:MM:SS] [LEVEL] 消息内容
 *
 * 级别过滤规则:
 * - Debug 级别: 输出所有日志
 * - Info 级别: 输出 Info, Warning, Error
 * - Warning 级别: 输出 Warning, Error
 * - Error 级别: 只输出 Error
 *
 * 线程安全:
 * - 所有日志方法都是线程安全的
 * - 使用互斥锁保护日志输出
 *
 * 使用场景:
 * - 替代 std::cout 输出一般信息
 * - 替代 std::cerr 输出错误信息
 * - 调试时输出详细的执行流程
 * - 生产环境设置 Info 级别，调试时设置 Debug 级别
 *
 * 示例:
 * @code
 * // 设置日志级别
 * Logger::setLogLevel(LogLevel::Info);
 *
 * // 输出不同级别的日志
 * Logger::debug("Entering function foo()");
 * Logger::info("Recording started");
 * Logger::warning("Buffer size is low: %d bytes", bufferSize);
 * Logger::error("Failed to open audio device: %d", errorCode);
 *
 * // 格式化输出
 * Logger::infof("Recording progress: %.2f%%", progress * 100.0);
 * Logger::errorf("Process %d (PID %d) exited unexpectedly", processID, pid);
 * @endcode
 */
class Logger {
public:
    /**
     * @brief 设置全局日志级别
     *
     * 设置日志过滤级别，只有大于等于此级别的日志会被输出。
     *
     * @param level 日志级别
     *
     * @note 默认级别为 Info
     * @note 此方法是线程安全的
     */
    static void setLogLevel(LogLevel level);

    /**
     * @brief 获取当前日志级别
     * @return 当前全局日志级别
     */
    static LogLevel getLogLevel();

    /**
     * @brief 启用/关闭兼容格式日志输出
     *
     * 兼容格式与 audioFmtConvert 保持一致：
     * YYYY-MM-DD HH:MM:SS,mmm LEVEL [default] message
     */
    static void setCompatFormat(bool enabled);

    /**
     * @brief 设置日志文件路径（追加写入）
     *
     * @param path 日志文件路径
     * @return 是否成功打开文件
     */
    static bool setLogFile(const std::string& path);

    // ==================== 便捷日志方法 ====================

    /**
     * @brief 输出 Debug 级别日志
     * @param message 日志消息
     */
    static void debug(const std::string& message);

    /**
     * @brief 输出 Info 级别日志
     * @param message 日志消息
     */
    static void info(const std::string& message);

    /**
     * @brief 输出 Warning 级别日志
     * @param message 日志消息
     */
    static void warning(const std::string& message);

    /**
     * @brief 输出 Error 级别日志
     * @param message 日志消息
     */
    static void error(const std::string& message);

    // ==================== 格式化日志方法 ====================

    /**
     * @brief 输出格式化 Debug 日志
     *
     * 使用 printf 风格的格式化字符串。
     *
     * @param format 格式化字符串
     * @param ... 可变参数
     *
     * @note 最大日志长度为 4096 字节
     */
    static void debugf(const char* format, ...) __attribute__((format(printf, 1, 2)));

    /**
     * @brief 输出格式化 Info 日志
     * @param format 格式化字符串
     * @param ... 可变参数
     */
    static void infof(const char* format, ...) __attribute__((format(printf, 1, 2)));

    /**
     * @brief 输出格式化 Warning 日志
     * @param format 格式化字符串
     * @param ... 可变参数
     */
    static void warningf(const char* format, ...) __attribute__((format(printf, 1, 2)));

    /**
     * @brief 输出格式化 Error 日志
     * @param format 格式化字符串
     * @param ... 可变参数
     */
    static void errorf(const char* format, ...) __attribute__((format(printf, 1, 2)));

private:
    /**
     * @brief 核心日志输出方法
     *
     * 所有日志方法最终都会调用此方法。
     *
     * @param level 日志级别
     * @param message 日志消息
     */
    static void log(LogLevel level, const std::string& message);

    /**
     * @brief 获取日志级别前缀
     *
     * @param level 日志级别
     * @return 日志级别字符串 (例如 "DEBUG", "INFO")
     */
    static const char* getLevelPrefix(LogLevel level);

    /**
     * @brief 获取当前时间戳字符串
     *
     * 格式: [YYYY-MM-DD HH:MM:SS]
     *
     * @return 时间戳字符串
     */
    static std::string getCurrentTimestamp();

    // ==================== 静态成员变量 ====================

    static LogLevel currentLevel_;  // 当前日志级别
    static std::mutex mutex_;       // 日志输出互斥锁
};

} // namespace bitbook::utils

#endif // LOGGER_H
