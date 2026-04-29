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


def nlms_echo_cancel(ref, mic, filter_len=1024, mu=0.1, block_size=256, leak=0.0001):
    """
    NLMS (Normalized Least Mean Squares) 自适应回声消除。
    相比 LMS：步长按参考信号功率归一化，更稳定，不易发散。
    
    参数:
        ref: 参考信号 (BlackHole)，shape (n,)
        mic: 带噪信号 (麦克风)，shape (n,)
        filter_len: 滤波器长度（默认 1024 ≈ 64ms @16kHz）
        mu: 归一化步长（0.05-0.5）
        block_size: 每块采样数
        leak: 泄露因子，防止权重漂移（0 = 无泄露）
    """
    n = min(len(ref), len(mic))
    ref = ref[:n]
    mic = mic[:n]

    # 信号归一化
    peak = max(np.max(np.abs(ref)), np.max(np.abs(mic)), 1e-10)
    ref = ref / peak
    mic = mic / peak

    w = np.zeros(filter_len, dtype=np.float32)
    clean = np.zeros(n, dtype=np.float32)
    eps = 1e-6  # 避免除零

    for start in range(filter_len, n, block_size):
        end = min(start + block_size, n)

        for i in range(start, end):
            ref_block = ref[i - filter_len:i][::-1]
            
            # 滤波器输出（估计回声）
            y = np.dot(w, ref_block)
            
            # 误差信号 = 麦克风 - 估计回声
            e = mic[i] - y
            
            # NLMS 更新：步长按 ||ref_block||² 归一化
            norm = np.dot(ref_block, ref_block) + eps
            w = (1 - leak) * w + (mu / norm) * e * ref_block
            
            clean[i] = e

    # 恢复音量，限制在合理范围
    clean = np.clip(clean * peak * 0.5, -1.0, 1.0)
    return clean.astype(np.float32)


def echo_cancel(sys_path, mic_path, output_path):
    """对一对录制文件执行回声消除。"""
    print(f"📖 读取参考(系统音频): {sys_path}")
    sr_ref, ref = read_wav(sys_path)
    print(f"📖 读取带噪(麦克风): {mic_path}")
    sr_mic, mic = read_wav(mic_path)

    sr = sr_ref if sr_ref == sr_mic else min(sr_ref, sr_mic)
    if sr_ref != sr_mic:
        print(f"⚠️ 采样率不一致: {sr_ref} vs {sr_mic}, 以 {sr} 为准")

    # 对齐到相同长度
    min_len = min(len(ref), len(mic))

    # 互相关对齐时间偏移（修正 BlackHole 与麦克风启动时间差）
    corr_len = min(48000, min_len)  # 最多 1 秒搜索
    corr = np.correlate(mic[:corr_len], ref[:corr_len], mode='valid')
    delay = int(np.argmax(np.abs(corr)))
    if delay > 100:  # 至少 100 采样点才值得对齐
        print(f"⏱️ 检测到 {delay} 采样点偏移 ({delay/sr*1000:.1f}ms)，自动对齐")
        ref = ref[:min_len - delay]
        mic = mic[delay:min_len]
        min_len = min(len(ref), len(mic))
        ref = ref[:min_len]
        mic = mic[:min_len]
    else:
        ref = ref[:min_len]
        mic = mic[:min_len]

    print(f"🔊 回声消除中 ({min_len/sr:.1f}s, {sr}Hz, filter={1024})...")
    clean = nlms_echo_cancel(ref, mic)
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
