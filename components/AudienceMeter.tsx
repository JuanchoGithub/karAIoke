import React from 'react';
import { Smile, Frown, Flame } from 'lucide-react';

interface AudienceMeterProps {
  mood: number; // 0-100
  combo: number;
}

const AudienceMeter: React.FC<AudienceMeterProps> = ({ mood, combo }) => {
  // Determine color based on mood
  let color = 'bg-red-500';
  let Icon = Frown;
  let text = 'BOOO!';

  if (mood > 30) {
    color = 'bg-yellow-500';
    Icon = Smile;
    text = 'Listening...';
  }
  if (mood > 70) {
    color = 'bg-green-500';
    Icon = Flame;
    text = 'HYPED!';
  }
  if (mood > 90) {
    color = 'bg-purple-500';
    Icon = Flame;
    text = 'LEGENDARY!';
  }

  return (
    <div className="bg-slate-800/80 p-4 rounded-xl border border-slate-700 backdrop-blur-md flex flex-col gap-2 w-48 shadow-lg">
      <div className="flex justify-between items-center">
        <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Crowd</span>
        <span className={`text-xs font-bold ${mood > 70 ? 'text-purple-400' : 'text-slate-400'}`}>{mood}%</span>
      </div>
      
      {/* Meter Bar */}
      <div className="h-4 w-full bg-slate-900 rounded-full overflow-hidden relative border border-slate-700">
        <div 
          className={`h-full ${color} transition-all duration-300 ease-out`}
          style={{ width: `${mood}%` }}
        />
        {/* Combo overlay effect */}
        {combo > 10 && (
           <div className="absolute inset-0 bg-white/20 animate-pulse" />
        )}
      </div>

      <div className="flex items-center gap-2 mt-1">
        <Icon size={20} className={mood > 70 ? 'text-purple-400 animate-bounce' : 'text-slate-400'} />
        <span className="font-bold text-sm text-white">{text}</span>
      </div>
      
      {combo > 5 && (
        <div className="mt-2 text-center animate-bounce">
            <span className="text-2xl font-black text-transparent bg-clip-text bg-gradient-to-r from-yellow-400 to-orange-500">
                {combo} COMBO!
            </span>
        </div>
      )}
    </div>
  );
};

export default AudienceMeter;
