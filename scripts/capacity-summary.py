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
import re
import sys
from collections import defaultdict

# Uma linha do `--trace-gc`, tal qual o Node escreve no stdout:
#
#   [7:0x7f..]  1236 ms: Scavenge 38.4 (44.1) -> 37.8 (45.9) MB, pooled: 0 MB,
#                      1.71 / 0.00 ms  (average mu = 0.991, ...) allocation failure;
#   [7:0x7f..]  1282 ms: Mark-Compact 42.5 (51.1) -> 30.4 (47.9) MB, pooled: 3 MB,
#                      2.48 / 0.00 ms  (+ 0.7 ms in 0 steps ...) ... task;
#
# O `.*?` antes da pausa e obrigatorio: a linha do Mark-Compact traz um
# `(+ 0.7 ms in 0 steps since start of marking ...)` que tambem casa com
# "<numero> / <numero> ms" se a regex nao ancorar no "MB," que vem logo antes.
GC_LINE = re.compile(
    r"^\[(?P<pid>\d+):0x[0-9a-f]+\]\s+\d+ ms: "
    r"(?P<kind>Scavenge|Mark-sweep|Mark-Compact)(?:\s+\([a-z ]+\))?\s+"
    r"(?P<before>[\d.]+) \([\d.]+\) -> (?P<after>[\d.]+) \([\d.]+\) MB"
    r".*?, (?P<pause>[\d.]+) / (?P<aux>[\d.]+) ms"
)


def parse_gc(path):
    """Contas de coleta do rastro de GC, por pid e somadas.

    Separate `Scavenge` (o coletor de geração nova, milissegundos) de
    `Mark-sweep`/`Mark-Compact` (o completo, o unico que pode pausar o event
    loop por tempo visivel) porque os dois nao contam a mesma coisa: a
    frequencia de scavenge mede taxa de alocacao, e a de mark-sweep mede
    crescimento da geração velha -- que é o que o `--max-old-space-size`
    limita.

    `heap_before_max` e o pico de heap no instante ANTES da coleta, e
    `heap_after_max` o pico logo depois. Os dois juntos sao o que diz se o
    processo esta crescendo (eles sobem) ou se so esta ciclando (eles sao
    estaveis).
    """
    empty = {
        "workers_seen": 0, "gc": 0, "scavenge": 0, "mark": 0,
        "pause_ms": 0.0, "pause_max_ms": 0.0,
        "heap_before_max": None, "heap_after_max": None, "unparsed": 0,
    }
    if not path or not os.path.exists(path):
        return None

    pids = set()
    totals = {"gc": 0, "scavenge": 0, "mark": 0}
    pause_total = 0.0
    pause_max = 0.0
    heap_before_max = None
    heap_after_max = None
    unparsed = 0

    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if not line.strip():
                continue
            m = GC_LINE.match(line)
            if not m:
                unparsed += 1
                continue
            pause = float(m.group("pause"))
            before = float(m.group("before"))
            after = float(m.group("after"))
            pids.add(m.group("pid"))
            totals["gc"] += 1
            if m.group("kind") == "Scavenge":
                totals["scavenge"] += 1
            else:
                totals["mark"] += 1
            pause_total += pause
            pause_max = max(pause_max, pause)
            heap_before_max = max(heap_before_max or 0.0, before)
            heap_after_max = max(heap_after_max or 0.0, after)

    if not pids:
        # Um rastro sem nenhuma linha reconhecivel e pior do que rastro
        # ausente: nao pode ser lido como "esta corrida nao coletou", que e uma
        # afirmacao forte e falsa. Fica com contagem zero e as linhas nao lidas
        # a mostra, para a tabela marcar a corrida como nao medida.
        return dict(empty, unparsed=unparsed)

    return {
        "workers_seen": len(pids),
        "gc": totals["gc"],
        "scavenge": totals["scavenge"],
        "mark": totals["mark"],
        "pause_ms": round(pause_total, 1),
        "pause_max_ms": round(pause_max, 2),
        "heap_before_max": round(heap_before_max, 1),
        "heap_after_max": round(heap_after_max, 1),
        "unparsed": unparsed,
    }


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
        # `w1_login_v400_if256_20260930_...`: o teto do disjuntor entra na
        # tabela, porque uma corrida com teto e outra sem ele sao servicos
        # diferentes e comparar as duas sem o valor seria mentir.
        in_flight = ""
        parts = base.split("_")
        if len(parts) > 3 and parts[3].startswith("if"):
            in_flight = parts[3][2:]
        stamp = base.rsplit("_", 2)[-1]
        for endpoint, e in data["endpoints"].items():
            prefix = f"{base[:-len(stamp)].rstrip('_')}_"
            mem_files = sorted(glob.glob(os.path.join(out_dir, f"mem_{prefix}*.csv")))
            stats_files = sorted(glob.glob(os.path.join(out_dir, f"stats_{prefix}*.csv")))
            gc_files = sorted(glob.glob(os.path.join(out_dir, f"gc_{prefix}*.log")))
            rows.append({
                "workers": workers,
                "in_flight": in_flight,
                "vus": data["vus"],
                "endpoint": endpoint,
                "duration_s": data.get("test_duration_s"),
                "e": e,
                "mem": peak_memory(mem_files[0] if mem_files else None),
                "stats": docker_peak(stats_files[0] if stats_files else None),
                "gc": parse_gc(gc_files[0] if gc_files else None),
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

    print("| workers | teto in-flight | VUs | endpoint | reqs | rps | p50 ms | p95 ms | p99 ms | max ms | 429 | 4xx | 5xx | 503 | falha % | RSS pico MB | heap pico MB | CPU pico % |")
    print("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for r in rows:
        e = r["e"]
        mem = r["mem"] or {}
        stats = r["stats"] or {}
        print(
            f"| {r['workers']} | {r['in_flight'] or '-'} | {r['vus']} | /{r['endpoint']} | {e['requests']} | {e['rps']} | "
            f"{e['p50_ms']} | {e['p95_ms']} | {e['p99_ms']} | {e['max_ms']} | "
            f"{e['refused_429']} | {e['client_4xx']} | {e.get('server_5xx', '-')} | "
            f"{e.get('overloaded_503', '-')} | {e['failure_pct']} | "
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

    print_gc_table(rows)


def print_gc_table(rows):
    """Tabela de GC, separada da de latencia porque sao coisas diferentes.

    A tabela principal tem 19 colunas e ja nao cabe: as contas de coleta vao em
    uma tabela propria, que e onde a Fase 3.2 le o dado para decidir o teto de
    heap.
    """
    print()
    print("## Coletas de GC na janela de carga\n")
    gc_rows = [r for r in rows if r.get("gc")]
    if not gc_rows:
        print("_Nenhum rastro de GC encontrado. As corridas foram feitas sem "
              "`--trace-gc` (ou com `--no-gc-trace`); heap Used/Total na "
              "primeira tabela continua valendo, mas nao ha contagem de "
              "coleta nem tempo de pausa._\n")
        return

    print("`heap pre` e o maior valor de heap que a coleta encontrou (o topo do")
    print("dente de serra) e `heap pos` o que sobrou logo depois. Se os dois sobem")
    print("ao longo da corrida, o processo esta crescendo; se `heap pos` fica")
    print("abaixo e `heap pre` repete o mesmo teto, ele so esta ciclando.\n")

    print("| workers | endpoint | VUs | coletadas | scavenge | mark | "
          "pausa total ms | pausa max ms | pausa % janela | heap pre MB | heap pos MB |")
    print("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for r in gc_rows:
        g = r["gc"]
        window_ms = (r.get("duration_s") or 0) * 1000
        share = f"{g['pause_ms'] / window_ms * 100:.2f}" if window_ms else "-"
        before = g["heap_before_max"] if g["heap_before_max"] is not None else "-"
        after = g["heap_after_max"] if g["heap_after_max"] is not None else "-"
        print(
            f"| {r['workers']} | /{r['endpoint']} | {r['vus']} | {g['gc']} | "
            f"{g['scavenge']} | {g['mark']} | {g['pause_ms']} | {g['pause_max_ms']} | "
            f"{share} | {before} | {after} |"
        )

    unparsed = sum(r["gc"]["unparsed"] for r in gc_rows)
    if unparsed:
        print()
        print(f"Atencao: {unparsed} linha(s) do rastro ficaram sem casamento "
              f"no parser e nao entram nas contas acima.")


if __name__ == "__main__":
    main()
