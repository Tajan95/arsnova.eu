import unittest
from simulate import COMMIT, Job, simulate, validate_calibration, workload


class SimulatorTest(unittest.TestCase):
    def test_idle_single_job(self):
        s, rows, _ = simulate([Job(0,0,'qa_summary',2,3)],1,10)
        self.assertEqual(s['model_success'],1)
        self.assertEqual(rows[0]['finish_s'],5)
        self.assertAlmostEqual(s['occupancy_fraction_within_window'],.3)

    def test_busy_rejection_no_hidden_wait(self):
        s, rows, _ = simulate([Job(0,0,'qa_summary',0,3),Job(1,1,'qa_summary',1,3)],2,10)
        self.assertEqual(s['busy_rejected'],1)
        self.assertEqual(rows[1]['response_s'],0)
        self.assertIsNone(rows[1]['start_s'])
        self.assertEqual(s['max_waiting'],0)

    def test_completion_precedes_same_time_arrival(self):
        s, _, _ = simulate([Job(0,0,'qa_summary',0,3),Job(1,1,'qa_summary',3,3)],2,10)
        self.assertEqual(s['model_success'],2)

    def test_fifo_capacity_counts_active(self):
        jobs=[Job(i,i,'qa_summary',0,2) for i in range(4)]
        s, rows, _ = simulate(jobs,4,20,'fifo',capacity=3)
        self.assertEqual(s['busy_rejected'],1)
        self.assertEqual(s['max_waiting'],2)
        self.assertEqual([r['wait_s'] for r in rows],[0,2,4,None])

    def test_failed_job_keeps_its_occupancy(self):
        s, _, _=simulate([Job(0,0,'qa_summary',0,5,False),Job(1,1,'topic_label',1,1)],2,10)
        self.assertEqual(s['model_failed'],1)
        self.assertEqual(s['model_success'],0)
        self.assertEqual(s['busy_rejected'],1)
        self.assertEqual(s['occupancy_fraction_within_window'],.5)

    def test_drain_is_separate_from_window(self):
        s, _, _=simulate([Job(0,0,'qa_summary',9,3)],1,10)
        self.assertEqual(s['model_success'],1)
        self.assertEqual(s['successful_jobs_within_window'],0)
        self.assertEqual(s['drained_until_s'],12)
        self.assertAlmostEqual(s['occupancy_fraction_within_window'],.1)

    def test_cache_requires_previous_success_and_retains_source_age(self):
        jobs=[Job(0,0,'qa_summary',0,2,True,0),Job(1,0,'qa_summary',3,2,True,0)]
        s,rows,_=simulate(jobs,1,10,cache_probability=1)
        self.assertEqual(s['model_success'],1)
        self.assertEqual(s['cache_hit'],1)
        self.assertEqual(rows[1]['analysis_age_s'],3)

    def test_host_cooldown_countervariant(self):
        s,_,_=simulate([Job(0,0,'topic_label',0,1),Job(1,0,'qa_summary',2,1)],1,10,cooldown=5)
        self.assertEqual(s['cooldown_rejected'],1)

    def test_fifo_wait_increases_snapshot_age(self):
        _,rows,_=simulate([Job(0,0,'topic_label',0,5),Job(1,1,'qa_summary',1,3)],2,10,'fifo')
        self.assertEqual(rows[1]['response_s'],7)
        self.assertEqual(rows[1]['analysis_age_s'],7)

    def test_cost_includes_idle_and_drain(self):
        s,_,_=simulate([Job(0,0,'qa_summary',9,3)],1,10,hourly_cost=3600)
        self.assertEqual(s['modeled_total_cost_eur'],12)
        self.assertEqual(s['modeled_cost_per_success_eur'],12)

    def test_seed_reproducible_and_participant_number_not_job_rate(self):
        samples={k:[dict(duration_ms=1000,success=True)] for k in ['topic_label','qa_summary','learning_objectives']}
        a=workload(100,600,120,'synchronized',1,samples,'random')
        b=workload(100,600,120,'synchronized',1,samples,'random')
        self.assertEqual(a,b)
        self.assertEqual(len(a),500)

    def test_empty_and_zero_success_fairness_undefined(self):
        s,_,_=simulate([],2,10)
        self.assertIsNone(s['jain_model_successes'])
        self.assertIsNone(s['model_success_fraction'])

    def test_synchronization_only_changes_arrival_phase(self):
        samples={k:[dict(duration_ms=v,success=True) for v in (1000,2000)]
                 for k in ['topic_label','qa_summary','learning_objectives']}
        dispersed=workload(100,600,120,'dispersed',1,samples,'random')
        synchronized=workload(100,600,120,'synchronized',1,samples,'random')
        def per_session(jobs,session):
            return [(j.kind,j.service,j.success,j.cache_roll) for j in jobs if j.session==session]
        for session in range(100):
            self.assertEqual(per_session(dispersed,session),per_session(synchronized,session))

    def test_calibration_rejects_stubs_wrong_commit_and_incomplete_samples(self):
        valid=dict(schema_version=1,evidence='real_private_runtime',baseline_commit=COMMIT,
                   environment_manifest='actual-manifest.json',samples={k:[dict(duration_ms=1,success=True)]
                       for k in ['topic_label','qa_summary','learning_objectives']})
        self.assertIs(validate_calibration(valid),valid)
        for field,bad in [('evidence','mock'),('baseline_commit','other'),('samples',{}),('environment_manifest','')]:
            with self.assertRaises(ValueError): validate_calibration(dict(valid,**{field:bad}))

    def test_admission_failures_cannot_be_service_samples(self):
        for status in ['busy','circuit_open','disabled','misconfigured','unavailable']:
            value=dict(schema_version=1,evidence='real_private_runtime',baseline_commit=COMMIT,
                       environment_manifest='actual-manifest.json',samples={k:[dict(duration_ms=1,success=False,status=status)]
                           for k in ['topic_label','qa_summary','learning_objectives']})
            with self.assertRaises(ValueError): validate_calibration(value)


if __name__ == '__main__':
    unittest.main()
