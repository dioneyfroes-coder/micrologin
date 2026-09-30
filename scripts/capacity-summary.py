#!/usr/bin/env python3
"""Consolida as saidas de `scripts/capacity-baseline.sh` em uma tabela.

Le os `k6_*.json` (p50/p95/p99, rps, recusas, taxa de falha) e casa cada um
com o `mem_*.csv` da mesma corrida (RSS e heap de pico, por pid e somados no
container).

A separacao por pid existe porque `/observability` responde pelo processo que o
kernel escolheu naquele accept: uma chamada devolve UM worker, nao o container.
Com N workers sao necessarias N amostras para cobrir todos, e o agregado assume
que a janela de carga deu amostras suficientes - por isso ele tambem reporta
`workers_vistos`, que e menor que N quando a janela foi curta demais.
"""
import csv
import glob
import json
import os
import sys
from collections import defaultdict


def peak_memory(path):
    """RSS e heap de pico por pid, mais a soma no container."""
    per_pid = defaultdict(lambda: [0.0, 0.0])
    if not path or not os.path.exists(path):
        return None
    with open(path, newline="") as fh:
        for row in csv.DictReader(fh):
            try:
                pid = row["pid"]
                rss = float(row["rss_mb"])
                heap = float(row["heap_used_mb"])
            except (KeyError, TypeError, ValueError):
                continue
            per_pid[pid][0] = max(per_pid[pid][0], rss)
            per_pid[pid][1] = max(per_pid[pid][1], heap)
    if not per_pid:
        return None
    return {
        "workers_seen": len(per_pid),
        "rss_sum": round(sum(v[0] for v in per_pid.values()), 1),
        "heap_sum": round(sum(v[1] for v in per_pid.values()), 1),
        "rss_max": round(max(v[0] for v in per_pid.values()), 1),
        "heap_max": round(max(v[1] for v in per_pid.values()), 1),
    }


def docker_peak(path):
    """CPU e memoria do container no pico, lidos de `docker stats`."""
    if not path or not os.path.exists(path):
        return None
    cpu = 0.0
    mem_pct = 0.0
    with open(path, newline="") as fh:
        for row in csv.DictReader(fh):
            try:
                cpu = max(cpu, float(str(row["cpu_pct"]).replace("%", "").strip()))
                mem_pct = max(mem_pct, float(str(row["mem_pct"]).replace("%", "").strip()))
            except (KeyError, TypeError, ValueError):
                continue
    return {"cpu_pct": round(cpu, 1), "mem_pct": round(mem_pct, 1) if mem_pct else None}


def load_rows(out_dir):
    rows = []
    for path in sorted(glob.glob(os.path.join(out_dir, "k6_*.json"))):
        with open(path) as fh:
            data = json.load(fh)
        base = os.path.basename(path)[len("k6_"):-len(".json")]
        workers = base.split("_")[0].lstrip("w")
        stamp = base.rsplit("_", 2)[-1]
        for endpoint, e in data["endpoints"].items():
            prefix = f"{base[:-len(stamp)].rstrip('_')}_"
            mem_files = sorted(glob.glob(os.path.join(out_dir, f"mem_{prefix}*.csv")))
            stats_files = sorted(glob.glob(os.path.join(out_dir, f"stats_{prefix}*.csv")))
            rows.append({
                "workers": workers,
                "vus": data["vus"],
                "endpoint": endpoint,
                "duration_s": data.get("test_duration_s"),
                "e": e,
                "mem": peak_memory(mem_files[0] if mem_files else None),
                "stats": docker_peak(stats_files[0] if stats_files else None),
            })
    return rows


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "artifacts/capacity"
    rows = load_rows(out_dir)

    print("# Baseline de capacidade (registro cru)\n")
    print("Gerado por `scripts/capacity-baseline.sh`. A interpretacao e a tabela")
    print("publicada ficam em `docs/metricas.md`; este arquivo e o dado bruto.\n")

    if not rows:
        print("_Nenhuma corrida encontrada em "
              f"`{out_dir}`._\n")
        return

    print("| workers | VUs | endpoint | reqs | rps | p50 ms | p95 ms | p99 ms | max ms | 429 | 4xx | 5xx | falha % | RSS pico MB | heap pico MB | CPU pico % |")
    print("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for r in rows:
        e = r["e"]
        mem = r["mem"] or {}
        stats = r["stats"] or {}
        print(
            f"| {r['workers']} | {r['vus']} | /{r['endpoint']} | {e['requests']} | {e['rps']} | "
            f"{e['p50_ms']} | {e['p95_ms']} | {e['p99_ms']} | {e['max_ms']} | "
            f"{e['refused_429']} | {e['client_4xx']} | {e.get('server_5xx', '-')} | {e['failure_pct']} | "
            f"{mem.get('rss_sum', '-')} | {mem.get('heap_sum', '-')} | "
            f"{stats.get('cpu_pct', '-')} |"
        )

    print()
    print("`workers_vistos` = processos distintos que responderam `/observability`")
    print("durante a janela de carga. Abaixo do esperado significa janela curta")
    print("de amostragem, e a soma de RSS subestima o container.\n")
    print("| workers pedido | endpoint | VUs | workers vistos |")
    print("| --- | --- | --- | --- |")
    for r in rows:
        if r["mem"]:
            print(f"| {r['workers']} | /{r['endpoint']} | {r['vus']} | {r['mem']['workers_seen']} |")


if __name__ == "__main__":
    main()
