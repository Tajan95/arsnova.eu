#!/usr/bin/env python3
"""Optional figure renderer; needs matplotlib, simulation itself is standardlib."""
import argparse
import json
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.ticker import MaxNLocator


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--summary',type=Path,required=True)
    p.add_argument('--out',type=Path,required=True)
    args=p.parse_args()
    data=json.loads(args.summary.read_text())
    if data['evidence'] != 'CALIBRATED_SIMULATION_NOT_MEASUREMENT':
        raise ValueError('This figure is reserved for actual measured-service calibration')
    rows=data['results']
    labels=['Versetzt · sofort abweisen','Versetzt · FIFO 8',
            'Synchron, zufällig · abweisen','Synchron, zufällig · FIFO 8',
            'Synchron, feste Reihenfolge · abweisen','Synchron, feste Reihenfolge · FIFO 8']
    colors=['#23648A' if r['policy']=='reject' else '#D48032' for r in rows]
    plt.rcParams.update({'font.family':'DejaVu Sans','font.size':12,'axes.spines.top':False,
                         'axes.spines.right':False})
    fig,axes=plt.subplots(1,3,figsize=(16,8),sharey=True)
    fig.subplots_adjust(left=.29,right=.97,top=.70,bottom=.31,wspace=.35)
    values=[[100*r['model_success']/r['attempts'] for r in rows],
            [r['no_success_sessions'] for r in rows], [r['wait_p95_s'] for r in rows]]
    titles=['Gültige Modellantworten\nAnteil aller Anfragen (%)',
            'Veranstaltungen ohne\ngültige Antwort (von 100)', 'Wartezeit p95\nangenommener Aufträge (s)']
    for i,(ax,vals,title) in enumerate(zip(axes,values,titles)):
        ax.barh(range(len(rows)),vals,color=colors,height=.58)
        ax.set_title(title,fontsize=13,pad=18)
        ax.set_yticks(range(len(rows)),labels)
        ax.grid(axis='x',alpha=.18)
        ax.set_axisbelow(True)
        ax.set_xlim(0,max(vals)*1.23 if i!=1 else 114)
        if i: ax.xaxis.set_major_locator(MaxNLocator(integer=True,nbins=4))
        for y,val in enumerate(vals):
            formatted=f'{val:.2f} %' if i==0 else f'{val:.0f}'
            ax.text(val+ax.get_xlim()[1]*.025,y,formatted,va='center',fontsize=12)
    axes[0].invert_yaxis()
    fig.suptitle('Ein Slot: Eine Warteschlange löst das Kapazitätsproblem nicht',
                 x=.04,y=.96,ha='left',fontsize=22,weight='bold')
    fig.text(.04,.885,'KALIBRIERTE SIMULATION · 100 Veranstaltungen × 50 rechnerische Teilnehmende',
             fontsize=14,color='#23648A',weight='bold')
    fig.text(.04,.845,'Je Host eine Aktion alle 120 s · 30 Minuten + Nachlauf · 1.500 Anfragen · Mix Label / Summary / Lernziel: 45 / 45 / 10 %',fontsize=12)
    fig.text(.04,.23,'Kalibrierung: n = 3 je Typ aus warmen Wiederholungen derselben Fixtures (KV-Cache); keine Messung neuer Veranstaltungskontexte.',fontsize=11,weight='bold')
    fig.text(.04,.185,'Native CPU ohne 5-GiB-Containergrenze; direkter Client ohne äußeren 8-s-Summary-Timer. FIFO 8 ist eine Laborgegenalternative.',fontsize=11)
    fig.text(.04,.14,'Anwendungscache im Modell: 0 Treffer. Das deaktiviert nicht den warmen KV-Cache in den Messproben.',fontsize=11)
    fig.text(.04,.095,'Erfolge nur bei Labels und Lernzielen; Summary 0/3. Feste Reihenfolge ist ein bewusst ungünstiger Fairnessfall.',fontsize=11)
    fig.text(.04,.05,'Quelle: eigene Messproben + Simulation, Seed 20261116, v1.3.0 / 87c39334. Kein 5.000-Client-Test und keine Produktionskapazität.',fontsize=10,color='#555555')
    args.out.mkdir(parents=True,exist_ok=True)
    for extension in ('png','svg','pdf'):
        fig.savefig(args.out/f'3B_Kalibrierte_Simulation.{extension}',dpi=180,facecolor='white')
    plt.close(fig)


if __name__=='__main__':
    main()
