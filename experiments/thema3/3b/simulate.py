#!/usr/bin/env python3
"""Reproducible single-slot abstraction; never an ARSnova app or model benchmark."""
from __future__ import annotations

import argparse
import csv
import heapq
import json
import math
import random
from collections import deque
from dataclasses import asdict, dataclass
from pathlib import Path

COMMIT = '87c39334619fbcb0c5782b061da1ba0df0ba3142'
KINDS = ('topic_label', 'qa_summary', 'learning_objectives')


@dataclass(frozen=True)
class Job:
    id: int
    session: int
    kind: str
    arrival: float
    service: float
    success: bool = True
    cache_roll: float = 1.0


def validate_calibration(value: dict) -> dict:
    if value.get('schema_version') != 1:
        raise ValueError('calibration schema_version must be 1')
    if value.get('evidence') != 'real_private_runtime':
        raise ValueError('calibration must declare real_private_runtime evidence')
    if value.get('baseline_commit') != COMMIT:
        raise ValueError('calibration must identify the fixed v1.3.0 baseline')
    if not value.get('environment_manifest'):
        raise ValueError('calibration must reference its actual environment manifest')
    for kind in KINDS:
        rows = value.get('samples', {}).get(kind)
        if not isinstance(rows, list) or not rows:
            raise ValueError(f'missing real samples for {kind}')
        for row in rows:
            duration = row.get('duration_ms')
            if isinstance(duration, bool) or not isinstance(duration, (int, float)):
                raise ValueError('duration_ms must be numeric')
            if not math.isfinite(duration) or duration <= 0:
                raise ValueError('duration_ms must be finite and positive')
            if not isinstance(row.get('success'), bool):
                raise ValueError('each sample needs explicit success true/false')
            if row.get('status') in ('busy', 'circuit_open', 'misconfigured', 'disabled', 'unavailable'):
                raise ValueError('immediate admission/config/transport failures are not model service samples')
            if 'status' in row and row['success'] != (row['status'] == 'completed'):
                raise ValueError('sample success contradicts explicit runtime status')
    return value


def workload(sessions, horizon, period, pattern, seed, samples, tie_order):
    rng = random.Random(seed)
    phase_rng = random.Random(seed ^ 0xA51C)
    phases = [phase_rng.uniform(0, period) if pattern == 'dispersed' else 0 for _ in range(sessions)]
    candidates = []
    for session, phase in enumerate(phases):
        moment = phase
        while moment < horizon:
            kind = rng.choices(KINDS, weights=(45, 45, 10))[0]
            sample = rng.choice(samples[kind])
            candidates.append((moment, session, kind, sample, rng.random(), rng.random()))
            moment += period
    # The order at exactly the same timestamp is an explicit assumption, not
    # measured fairness of the network. Fixed order models persistent advantage.
    candidates.sort(key=lambda x: (x[0], x[1] if tie_order == 'fixed' else x[5]))
    return [Job(i, row[1], row[2], row[0], row[3]['duration_ms'] / 1000,
                row[3]['success'], row[4]) for i, row in enumerate(candidates)]


def percentile(values, probability):
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(probability * len(ordered)) - 1)]


def jain(values):
    denominator = len(values) * sum(x*x for x in values)
    return sum(values)**2 / denominator if denominator else None


def simulate(jobs, sessions, horizon, policy='reject', capacity=8,
             cooldown=0.0, cache_probability=0.0, hourly_cost=None):
    """Event completions precede arrivals at ties; FIFO capacity includes active.

    The admission layer here sees model jobs. The real Summary app queue, TTL,
    auth, circuit breaker, app CPU and context construction are not modeled.
    No retry is automatically generated. Queueing has no preemption/deadline.
    """
    if policy not in ('reject', 'fifo') or capacity < 1:
        raise ValueError('invalid admission policy/capacity')
    if horizon <= 0 or sessions < 1 or cooldown < 0 or not 0 <= cache_probability <= 1:
        raise ValueError('invalid experiment limits')
    if hourly_cost is not None and hourly_cost < 0:
        raise ValueError('cost cannot be negative')
    events = []
    for order, job in enumerate(jobs):
        if not 0 <= job.session < sessions or job.service <= 0 or job.arrival < 0:
            raise ValueError('invalid job')
        if job.arrival >= horizon:
            raise ValueError('arrival outside measurement window')
        heapq.heappush(events, (job.arrival, 1, order, job))
    waiting = deque()
    active = None
    records = {}
    last_admitted = {}
    # Cache entry stores source snapshot time, not response-completion time.
    cache = {}
    model_busy_s = 0.0
    max_waiting = 0
    last_finish = horizon

    def start(job, now):
        nonlocal active, model_busy_s, last_finish
        assert active is None
        active = job
        record = records[job.id]
        record['start_s'] = now
        record['wait_s'] = now - job.arrival
        model_busy_s += max(0.0, min(now + job.service, horizon) - min(now, horizon))
        last_finish = max(last_finish, now + job.service)
        heapq.heappush(events, (now + job.service, 0, job.id, job))

    while events:
        now, event_kind, _, job = heapq.heappop(events)
        if event_kind == 0:
            assert active == job
            active = None
            r = records[job.id]
            r.update(status='model_success' if job.success else 'model_failed',
                     finish_s=now, response_s=now-job.arrival,
                     analysis_age_s=now-job.arrival if job.success else None)
            if job.success:
                cache[(job.session, job.kind)] = job.arrival
            if waiting:
                start(waiting.popleft(), now)
            continue
        records[job.id] = dict(asdict(job), status='', start_s=None, wait_s=None,
                               finish_s=now, response_s=0.0, analysis_age_s=None)
        r = records[job.id]
        key = (job.session, job.kind)
        if key in cache and job.cache_roll < cache_probability:
            r.update(status='cache_hit', analysis_age_s=now-cache[key])
            continue
        if now - last_admitted.get(job.session, -math.inf) < cooldown:
            r['status'] = 'cooldown_rejected'
            continue
        occupied = int(active is not None) + len(waiting)
        if active is not None and (policy == 'reject' or occupied >= capacity):
            r['status'] = 'busy_rejected'
            continue
        last_admitted[job.session] = now
        if active is None:
            start(job, now)
        else:
            waiting.append(job)
            max_waiting = max(max_waiting, len(waiting))

    rows = [records[j.id] for j in jobs]
    counts = {s: sum(r['status'] == s for r in rows) for s in (
        'model_success', 'model_failed', 'busy_rejected', 'cooldown_rejected', 'cache_hit')}
    served = [r for r in rows if r['status'] == 'model_success']
    per_session = []
    for session in range(sessions):
        group = [r for r in rows if r['session'] == session]
        good = [r for r in group if r['status'] == 'model_success']
        good_during = [r for r in good if r['finish_s'] <= horizon]
        summaries = [r for r in good_during if r['kind'] == 'qa_summary']
        final_source = max((r['arrival'] for r in summaries), default=None)
        per_session.append(dict(session=session, attempts=len(group),
            model_successes=len(good), model_successes_within_window=len(good_during),
            cache_hits=sum(r['status']=='cache_hit' for r in group),
            busy_rejected=sum(r['status']=='busy_rejected' for r in group),
            failed=sum(r['status']=='model_failed' for r in group),
            wait_p95_s=percentile([r['wait_s'] for r in group if r['wait_s'] is not None], .95),
            fresh_analysis_age_p95_s=percentile([r['analysis_age_s'] for r in good], .95),
            summary_age_at_horizon_s=None if final_source is None else horizon-final_source))
    cost = None if hourly_cost is None else hourly_cost * last_finish / 3600
    summary = dict(policy=policy, capacity_including_active=1 if policy=='reject' else capacity,
        sessions=sessions, participants_per_session=50, participant_count_is_not_job_count=True,
        observation_window_s=horizon, drained_until_s=last_finish, attempts=len(rows), **counts,
        successful_jobs_within_window=sum(r['finish_s']<=horizon for r in served),
        model_success_fraction=len(served)/len(rows) if rows else None,
        successful_model_jobs_per_minute=sum(r['finish_s']<=horizon for r in served)*60/horizon,
        occupancy_fraction_within_window=model_busy_s/horizon, max_waiting=max_waiting,
        no_success_sessions=sum(s['attempts']>0 and s['model_successes']==0 for s in per_session),
        no_success_sessions_within_window=sum(s['attempts']>0 and s['model_successes_within_window']==0 for s in per_session),
        jain_model_successes=jain([s['model_successes'] for s in per_session]),
        wait_p95_s=percentile([r['wait_s'] for r in rows if r['wait_s'] is not None], .95),
        response_p95_success_s=percentile([r['response_s'] for r in served], .95),
        analysis_age_p95_success_s=percentile([r['analysis_age_s'] for r in served], .95),
        cooldown_s=cooldown, conditional_cache_hit_probability=cache_probability,
        assumed_hourly_cost_eur=hourly_cost, modeled_total_cost_eur=cost,
        modeled_hours_per_success=None if not served else last_finish/3600/len(served),
        modeled_cost_per_success_eur=None if cost is None or not served else cost/len(served))
    assert sum(counts.values()) == len(rows)
    assert summary['occupancy_fraction_within_window'] <= 1.00000000001
    return summary, rows, per_session


def write_csv(path, rows):
    if not rows:
        path.write_text('')
        return
    with path.open('w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    source = p.add_mutually_exclusive_group(required=True)
    source.add_argument('--calibration', type=Path)
    source.add_argument('--illustrative', action='store_true', help='UNMEASURED assumptions; not a capacity result')
    p.add_argument('--out', type=Path, required=True)
    p.add_argument('--seed', type=int, default=20261116)
    p.add_argument('--sessions', type=int, default=100)
    p.add_argument('--horizon-s', type=float, default=1800)
    p.add_argument('--period-s', type=float, default=120, help='one host action per session per period')
    p.add_argument('--cooldown-s', type=float, default=0)
    p.add_argument('--cache-probability', type=float, default=0)
    p.add_argument('--hourly-cost-eur', type=float)
    args = p.parse_args()
    if args.period_s <= 0:
        p.error('--period-s must be positive')
    if args.calibration:
        calibration = validate_calibration(json.loads(args.calibration.read_text()))
        evidence = 'CALIBRATED_SIMULATION_NOT_MEASUREMENT'
        samples = calibration['samples']
    else:
        calibration = None
        evidence = 'UNCALIBRATED_ILLUSTRATION_NOT_CAPACITY_EVIDENCE'
        # Explicit invented teaching examples, never defaults disguised as data.
        samples = {k:[dict(duration_ms=d, success=True)] for k,d in zip(KINDS,(2000,12000,30000))}
    args.out.mkdir(parents=True, exist_ok=True)
    type_statistics = {kind:dict(n=len(samples[kind]),
        mean_service_s=sum(x['duration_ms'] for x in samples[kind])/1000/len(samples[kind]),
        observed_success_fraction=sum(x['success'] for x in samples[kind])/len(samples[kind])) for kind in KINDS}
    mean_service = sum(type_statistics[k]['mean_service_s']*w for k,w in zip(KINDS,(.45,.45,.10)))
    mean_success = sum(type_statistics[k]['observed_success_fraction']*w for k,w in zip(KINDS,(.45,.45,.10)))
    all_summaries = []
    for pattern, tie_order in [('dispersed','random'), ('synchronized','random'), ('synchronized','fixed')]:
        jobs = workload(args.sessions,args.horizon_s,args.period_s,pattern,args.seed,samples,tie_order)
        for policy in ('reject','fifo'):
            title = f'{pattern}_{tie_order}_{policy}'
            summary, rows, sessions = simulate(jobs,args.sessions,args.horizon_s,policy,
                cooldown=args.cooldown_s,cache_probability=args.cache_probability,hourly_cost=args.hourly_cost_eur)
            summary.update(scenario=title, evidence=evidence)
            all_summaries.append(summary)
            write_csv(args.out/(title+'_jobs.csv'), rows)
            write_csv(args.out/(title+'_sessions.csv'), sessions)
    record = dict(schema_version=1, evidence=evidence, baseline_commit=COMMIT,
        kind='SLOT_LAYER_ABSTRACTION_NOT_APPLICATION_EXECUTION', seed=args.seed,
        calibration_source=str(args.calibration) if args.calibration else None,
        calibration=calibration, service_samples=samples,
        calibration_statistics=dict(by_kind=type_statistics,
            assumed_mix_weighted_mean_service_s=mean_service,
            assumed_mix_weighted_success_fraction=mean_success,
            offered_occupancy_without_cache=args.sessions/args.period_s*mean_service,
            saturation_reference_jobs_per_minute=60/mean_service,
            saturation_reference_successes_per_minute=60*mean_success/mean_service,
            warning='Mix-based arithmetic reference, not measured throughput or full application capacity'),
        workload=dict(sessions=args.sessions,participants_per_session=50,
                      host_action_period_s=args.period_s,mix_weights=dict(zip(KINDS,(45,45,10))),
                      horizon_s=args.horizon_s),
        assumptions=['one shared slot; no preemption', 'global FIFO is countervariant, not actual Summary app queue',
                     'completion processed before same-time arrival', 'no automatic retry or model timeout added',
                     'service samples include recorded failures; successful jobs alone are counted as model success',
                     'requests admitted before horizon are drained, with within-window success also reported',
                     'cache needs earlier successful same-session/type result; eligibility is an explicit probabilistic assumption',
                     'source timestamp taken at request; actual context preparation/revalidation not simulated',
                     'no database/network/8.9b CPU load, auth, circuit breaker or app queue modeled',
                     'fixed tie order is a deliberately unfavorable case, not observed release fairness'],
        results=all_summaries)
    (args.out/'summary.json').write_text(json.dumps(record,indent=2,ensure_ascii=False)+'\n')
    write_csv(args.out/'comparison.csv',all_summaries)
    print(json.dumps(dict(evidence=evidence,out=str(args.out),scenarios=len(all_summaries))))


if __name__ == '__main__':
    main()
