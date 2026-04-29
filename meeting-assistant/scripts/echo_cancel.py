"""
声学回声消除（AEC）：用 BlackHole 参考信号从麦克风中消除系统音频回声。

原理：LMS (Least Mean Squares) 自适应滤波器
- 参考信号: BlackHole 录到的干净系统音频
- 带噪信号: 麦克风录到的人声 + 系统音频回声
- 输出   : 消除回声后的纯净人声

依赖: pip install numpy
"""

import json
import sys
import wave
from pathlib import Path

import numpy as np


def read_wav(path):
    """读取 WAV 文件返回 (sample_rate, samples_float32)。"""
    with wave.open(str(path), 'rb') as w:
        sr = w.getframerate()
        n = w.getnframes()
        raw = w.readframes(n)
        samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    return sr, samples


def write_wav(path, sr, samples):
    """写入 16-bit WAV 文件。"""
    with wave.open(str(path), 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((samples * 32767).astype(np.int16).tobytes())


def lms_echo_cancel(ref, mic, filter_len=2048, mu=0.005, block_size=256):
    """
    LMS 自适应回声消除。

    参数:
        ref: 参考信号 (BlackHole)，shape (n,)
        mic: 带噪信号 (麦克风)，shape (n,)
        filter_len: 滤波器长度（越长效果越好，但越慢）
        mu: 步长（太大会发散，太小收敛慢）
        block_size: 块大小，逐块处理减少延迟

    返回:
        clean: 消除回声后的信号
    """
    n = min(len(ref), len(mic))
    ref = ref[:n]
    mic = mic[:n]

    # 归一化信号
    ref_max = np.max(np.abs(ref)) or 1.0
    mic_max = np.max(np.abs(mic)) or 1.0
    ref = ref / ref_max
    mic = mic / mic_max

    clean = np.zeros(n, dtype=np.float32)
    w = np.zeros(filter_len, dtype=np.float32)

    for start in range(filter_len, n, block_size):
        end = min(start + block_size, n)
        block_len = end - start

        for i in range(start, end):
            # 滤波器输出
            ref_block = ref[i - filter_len:i][::-1]
            y = np.dot(w, ref_block)
            # 误差 = 麦克风 - 估计回声
            e = mic[i] - y
            # 更新滤波器权重
            w += mu * e * ref_block
            clean[i] = e

    # 恢复到原始音量水平
    clean = clean * mic_max
    return clean


def echo_cancel(sys_path, mic_path, output_path):
    """对一对录制文件执行回声消除。"""
    print(f"📖 读取参考(系统音频): {sys_path}")
    sr_ref, ref = read_wav(sys_path)
    print(f"📖 读取带噪(麦克风): {mic_path}")
    sr_mic, mic = read_wav(mic_path)

    if sr_ref != sr_mic:
        print(f"⚠️ 采样率不一致: {sr_ref} vs {sr_mic}, 以麦克风为准")

    sr = min(sr_ref, sr_mic)
    # 对齐到相同采样率
    if sr_ref != sr:
        from scipy import signal
        ref = signal.resample(ref, int(len(ref) * sr / sr_ref))
    if sr_mic != sr:
        from scipy import signal
        mic = signal.resample(mic, int(len(mic) * sr / sr_mic))

    # 互相关对齐两个信号（修正 BlackHole 与麦克风的启动时间差）
    corr = np.correlate(mic[:sr], ref[:sr], mode='valid')
    delay = np.argmax(np.abs(corr))
    if delay > 0:
        print(f"⏱️ 检测到 {delay} 采样点偏移 ({delay/sr*1000:.1f}ms)，自动对齐")
        ref = ref[:min_len - delay]
        mic = mic[delay:min_len]
    else:
        min_len = min(len(ref), len(mic))
        ref = ref[:min_len]
        mic = mic[:min_len]

    print(f"🔊 回声消除中 ({min_len/sr:.1f}s, {sr}Hz)...")
    clean = lms_echo_cancel(ref, mic)
    write_wav(output_path, sr, clean)

    size_mb = Path(output_path).stat().st_size / 1024 / 1024
    print(f"✅ 回声消除完成: {output_path} ({size_mb:.1f}MB)")
    return str(output_path)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: echo_cancel.py <sys_audio.wav> <mic_audio.wav> [output.wav]", file=sys.stderr)
        sys.exit(1)
    sys_path = sys.argv[1]
    mic_path = sys.argv[2]
    output_path = sys.argv[3] if len(sys.argv) > 3 else \
        str(Path(mic_path).with_suffix(".mic_clean.wav"))
    echo_cancel(sys_path, mic_path, output_path)
